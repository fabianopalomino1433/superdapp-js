import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { SuperDappAgent } from '../../src';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// Almacén temporal de información dinámica
let dynamicContext: string[] = [];
const CONTEXT_FILE = path.join(process.cwd(), 'dynamic_context.json');
const EVENTS_FILE = path.join(process.cwd(), 'luma_events.json');

// Variables para el caché de eventos
let isScraping = false;
const CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 horas en milisegundos

// Cargar contexto previo si existe
async function loadDynamicContext() {
    try {
        const data = await fs.readFile(CONTEXT_FILE, 'utf8');
        dynamicContext = JSON.parse(data);
        console.log('✅ Contexto dinámico cargado:', dynamicContext.length, 'entradas');
    } catch (error) {
        dynamicContext = [];
    }
}

async function saveDynamicContext() {
    await fs.writeFile(CONTEXT_FILE, JSON.stringify(dynamicContext, null, 2));
}

// Helper para obtener y formatear eventos con Caché
async function getFormattedEvents() {
    try {
        let shouldScrape = false;
        
        try {
            const stats = await fs.stat(EVENTS_FILE);
            const age = Date.now() - stats.mtimeMs;
            
            if (age > CACHE_DURATION) {
                console.log(`🕒 El caché de eventos tiene ${Math.round(age/1000/60)} minutos. Necesita actualización.`);
                shouldScrape = true;
            }
        } catch (error) {
            // Si el archivo no existe, debemos scrapper
            console.log('🆕 No existe el archivo de eventos. Iniciando primer scraping...');
            shouldScrape = true;
        }

        if (shouldScrape && !isScraping) {
            isScraping = true;
            // Ejecutar el script de scraping de forma asíncrona sin bloquear si ya tenemos datos
            console.log('🔄 Ejecutando scraper de eventos...');
            
            // Si ya existe el archivo, lo leemos primero para responder rápido
            let existingData = null;
            try {
                existingData = await fs.readFile(EVENTS_FILE, 'utf8');
            } catch (e) {}

            if (existingData) {
                // Ejecutamos en "background" (sin await prolongado aquí si es posible, 
                // pero como queremos los datos frescos si es la primera vez, 
                // aquí decidimos si esperar o no)
                execAsync('npx tsx scrape-events.ts').then(() => {
                    isScraping = false;
                    console.log('✅ Scraper finalizado en segundo plano.');
                }).catch(err => {
                    isScraping = false;
                    console.error('❌ Error en scraper de fondo:', err);
                });
                // Continuamos para mostrar los datos existentes (stale)
            } else {
                // Es la primera vez, tenemos que esperar sí o sí
                await execAsync('npx tsx scrape-events.ts');
                isScraping = false;
            }
        } else if (isScraping) {
            console.log('⏳ Ya hay un proceso de scraping en curso. Usando datos actuales.');
        }
        
        const data = await fs.readFile(EVENTS_FILE, 'utf8');
        const events = JSON.parse(data);
        
        if (!events || events.length === 0) {
            return "No encontré eventos programados por ahora. 😅";
        }

        const upcoming = events.filter((e: any) => e.type === 'upcoming');
        const past = events.filter((e: any) => e.type === 'past').slice(0, 5); // Mostrar solo los 5 más recientes

        let response = "📅 **Eventos del Club de Blockchain PUCP**\n\n";

        if (upcoming.length > 0) {
            response += "🚀 **Próximos Eventos:**\n";
            upcoming.forEach((e: any) => {
                response += `🔹 **${e.name}**\n   🗓️ ${e.date_raw} - ⏰ ${e.time_raw}\n   🔗 [Ver más en Luma](${e.url})\n\n`;
            });
        } else {
            response += "✨ No hay eventos próximos programados, ¡pero atento a nuestras redes!\n\n";
        }

        if (past.length > 0) {
            response += "📚 **Eventos Pasados Recientes:**\n";
            past.forEach((e: any) => {
                response += `✅ ${e.name} (${e.date_raw})\n`;
            });
        }

        if (isScraping) {
            response += "\n\n*(Estamos actualizando la lista, vuelve a preguntar en unos segundos para ver lo más reciente)* 🔄";
        }

        return response;
    } catch (error) {
        console.error('Error al obtener eventos:', error);
        return "❌ Hubo un error al intentar obtener los eventos. Por favor, intenta de nuevo más tarde.";
    }
}

// Middleware
app.use(cors());
app.use(express.json());

async function main() {
  await loadDynamicContext();
  try {
    // Initialize the agent
    const agent = new SuperDappAgent({
      apiToken: process.env.API_TOKEN as string,
      baseUrl:
        (process.env.API_BASE_URL as string) || 'https://api.superdapp.ai',
    });

    // Test connection
    console.log('🧪 Testing connection to SuperDapp API...');
    try {
        const botInfo = await agent.getClient().getBotInfo();
        console.log('✅ Connected to API successfully!');
        console.log('🤖 Bot Info:', JSON.stringify(botInfo).substring(0, 200));
    } catch (err: any) {
        console.error('❌ Failed to connect to SuperDapp API:', err.message);
        if (err.response) {
            console.error('📊 Status:', err.response.status);
            console.error('📄 Data:', JSON.stringify(err.response.data));
        }
    }

    // Helper para responder inteligentemente (Grupo vs DM)
    const reply = async (roomId: string, text: string, originalMessage: any, buttonRows: any[][] = []) => {
        // Detectar si es un grupo basándonos en el tipo de mensaje
        const isGroup = originalMessage?.__typename === 'ChannelMessage';
        
        try {
            if (isGroup) {
                // Es un grupo: Usamos el roomId que viene DENTRO del rawMessage (ese es el ID del grupo)
                const groupChannelId = originalMessage.roomId; 
                console.log(`📢 Respondiendo a grupo: ${groupChannelId}`);
                
                if (buttonRows.length > 0) {
                    await agent.sendChannelReplyMarkupMessage('buttons', groupChannelId, text, buttonRows);
                } else {
                    await agent.sendChannelMessage(groupChannelId, text);
                }
            } else {
                // Es DM: Usamos el roomId normal de la conexión
                console.log(`💬 Respondiendo a DM: ${roomId}`);
                if (buttonRows.length > 0) {
                    await agent.sendReplyMarkupMessage('buttons', roomId, text, buttonRows);
                } else {
                    await agent.sendConnectionMessage(roomId, text);
                }
            }
        } catch (error) {
            console.error('❌ Error enviando respuesta:', error);
        }
    };

    // --- Comandos Básicos ---

    // /start - Bienvenida
    agent.addCommand('/start', async ({ roomId, message }) => {
      await reply(
        roomId,
        "👋 **¡Hola! Soy Satoshin**, el asistente virtual del **Club de Blockchain PUCP**.\n\nEstoy aquí para responder tus dudas sobre el club, blockchain y nuestros proyectos. 🚀\n\nUsa `/help` para ver qué puedo hacer.",
        message.rawMessage
      );
    });

    // /ping - Verificación de estado
    agent.addCommand('/ping', async ({ roomId, message }) => {
      await reply(
        roomId,
        '🏓 **Pong!** Satoshin está en línea y listo para ayudar.',
        message.rawMessage
      );
    });

    // /help - Ayuda
    agent.addCommand('/help', async ({ roomId, message }) => {
      const helpText = `📋 **Comandos Disponibles**

🚀 \"/start\" - Iniciar conversación con Satoshin
ℹ️ \"/info\" - ¿Qué es el Club de Blockchain PUCP?
🛠️ \"/proyectos\" - Conoce nuestros proyectos actuales
📅 \"/eventos\" - Ver eventos del club
🤝 \"/unirse\" - Cómo ser parte del club
📧 \"/contacto\" - Nuestras redes sociales
❓ \"/help\" - Mostrar este menú de ayuda`;
      
      const buttonRows = [
        [
            { text: "ℹ️ Info", callback_data: "SHOW_INFO", style: "primary" },
            { text: "🛠️ Proyectos", callback_data: "SHOW_PROJECTS", style: "primary" }
        ],
        [
            { text: "📅 Eventos", callback_data: "SHOW_EVENTS", style: "primary" },
            { text: "🤝 Unirse", callback_data: "SHOW_JOIN", style: "secondary" }
        ],
        [
            { text: "📧 Contacto", callback_data: "SHOW_CONTACT", style: "secondary" }
        ]
      ];

      await reply(roomId, helpText, message.rawMessage, buttonRows);
    });

    // --- Comandos Informativos ---

    // /eventos - Scrapping de Luma
    agent.addCommand('/eventos', async ({ roomId, message }) => {
        await reply(roomId, "⏳ Un momento por favor, estoy buscando los últimos eventos en nuestro calendario...", message.rawMessage);
        const eventsText = await getFormattedEvents();
        await reply(roomId, eventsText, message.rawMessage);
    });

    // /info - Información del Club
    agent.addCommand('/info', async ({ roomId, message }) => {
      const infoText = `🏛️ **Sobre el Club de Blockchain PUCP**

Somos una organización estudiantil dedicada a la investigación, desarrollo y difusión de la tecnología Blockchain en la Pontificia Universidad Católica del Perú. 🎓

Nuestro objetivo es fomentar el conocimiento sobre **Bitcoin**, **Ethereum**, **Web3**, **DeFi** y más, creando un espacio para innovar y aprender juntos.`;
      
      await reply(roomId, infoText + "\n\n(Usa /proyectos o /eventos para más)", message.rawMessage);
    });

    // /proyectos - Proyectos
    agent.addCommand('/proyectos', async ({ roomId, message }) => {
      const proyectosText = `🛠️ **Nuestros Proyectos**

Actualmente estamos trabajando en varias iniciativas emocionantes:

1. **Talleres de Smart Contracts:** Aprende Solidity y desarrollo en Ethereum.
2. **Investigación DeFi:** Análisis de protocolos financieros descentralizados.
3. **Eventos y Hackathons:** Participación y organización de eventos Web3.
4. **Consultoría Blockchain:** Asesoría para startups y proyectos universitarios.`;

      await reply(roomId, proyectosText, message.rawMessage);
    });

    // /unirse - Cómo unirse
    agent.addCommand('/unirse', async ({ roomId, message }) => {
      const unirseText = `🤝 **¡Únete al Club!**

Estamos siempre buscando nuevos miembros apasionados por la tecnología. No necesitas ser un experto, ¡solo tener ganas de aprender!

📅 **Convocatorias:** Abrimos convocatorias al inicio de cada ciclo académico.
🔗 **Síguenos:** Mantente atento a nuestras redes sociales para las fechas exactas.`;
        
      await reply(roomId, unirseText, message.rawMessage);
    });

    // /contacto - Contacto
    agent.addCommand('/contacto', async ({ roomId, message }) => {
        const contactoText = `🔗 **Nuestras Redes Sociales**

Encuentra todos nuestros canales oficiales, redes y grupos aquí:
👉 [Linktree del Club](https://linktr.ee/club.blockchain.pucp)`;
        
        await reply(roomId, contactoText, message.rawMessage);
    });

    // --- Manejo de Callbacks (Botones) ---

    agent.addCommand('callback_query', async ({ message, roomId }) => {
      const action = message?.callback_command || '';

      switch (action) {
        case 'SHOW_INFO':
            await agent.commands['/info']({ message, replyMessage: null, roomId });
            break;

        case 'SHOW_PROJECTS':
            await agent.commands['/proyectos']({ message, replyMessage: null, roomId });
            break;

        case 'SHOW_EVENTS':
            await agent.commands['/eventos']({ message, replyMessage: null, roomId });
            break;

        case 'SHOW_JOIN':
            await agent.commands['/unirse']({ message, replyMessage: null, roomId });
            break;

        case 'SHOW_CONTACT':
            await agent.commands['/contacto']({ message, replyMessage: null, roomId });
            break;

        default:
          console.log(`Acción desconocida: ${action}`);
      }
    });

    // --- Manejo General de Mensajes ---

    agent.addCommand('handleMessage', async ({ message, roomId }) => {
      const text = message.data?.toLowerCase() || '';
      console.log('Mensaje recibido:', text);

      // 0. Prioridad: Pregunta por eventos
      if (text.includes('evento') || text.includes('actividad') || text.includes('agenda')) {
          await agent.commands['/eventos']({ message, replyMessage: null, roomId });
          return;
      }

      // 1. Prioridad: Contexto Dinámico (Inteligente)
      if (dynamicContext.length > 0) {
          const matches = dynamicContext.filter(entry => {
              const entryLower = entry.toLowerCase();
              const userWords = text.split(' ').filter(w => w.length > 3);
              return userWords.some(word => entryLower.includes(word));
          });

          if (matches.length > 0) {
              const latestMatch = matches[matches.length - 1];
              await reply(roomId, `📍 [Actualización] ${latestMatch}`, message.rawMessage);
              return;
          }
      }

      // 2. Comandos/Palabras clave estáticas
      if (text.includes('hola') || text.includes('buenos dias') || text.includes('buenos días')) {
          await reply(roomId, "¡Hola! ¿En qué puedo ayudarte hoy sobre el club?", message.rawMessage);
          return;
      }

      if (text.includes('blockchain') || text.includes('bitcoin')) {
          await reply(roomId, "¡Nos encanta hablar de eso! El Club se dedica a investigar esas tecnologías. Usa `/info` para saber más.", message.rawMessage);
          return;
      }
      
      if (text.includes('cuando') && (text.includes('reunion') || text.includes('reunión'))) {
          await reply(roomId, "Nuestras reuniones generales suelen ser los jueves a las 6pm (horario referencial). ¡Atento a los anuncios!", message.rawMessage);
          return;
      }

      // 3. Fallback inteligente
      if (dynamicContext.length > 0 && (text.includes('qué hay de nuevo') || text.includes('novedades') || text.includes('noticias'))) {
          const recent = dynamicContext.slice(-3).reverse().join('\n- ');
          await reply(roomId, `Últimas novedades recopiladas:\n- ${recent}`, message.rawMessage);
          return;
      }

      await reply(
        roomId,
        'No estoy seguro de cómo responder a eso 🤔. Pero puedo decirte sobre el club si usas /info o /help.',
        message.rawMessage
      );
    });

    // --- Servidor Web ---

    // Ingestión de datos desde OpenClaw
    app.post('/ingest', async (req, res) => {
        const { message, sender, channel } = req.body;
        if (sender !== '@MrT_Developer' && sender !== 'MrT_Developer') {
            return res.status(403).json({ error: 'Unauthorized sender' });
        }
        if (message) {
            dynamicContext.push(message);
            if (dynamicContext.length > 50) dynamicContext.shift();
            await saveDynamicContext();
            return res.status(200).json({ status: 'success', info: 'Data ingested' });
        }
        res.status(400).json({ error: 'No message provided' });
    });

    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'satoshin-agent',
        runtime: 'node',
      });
    });

    app.post('/webhook', async (req, res) => {
      try {
        const body = req.body;
        const msgText = body?.body?.m?.text || body?.body?.m?.body || 'EMPTY';
        console.log(`📥 Webhook received! Content: "${msgText}" from: ${body?.senderId || 'unknown'}`);
        
        // Respond IMMEDIATELY to SuperDapp to avoid the 60s timeout
        res.status(200).json({ status: 'processing' });

        // Process in background
        (async () => {
          try {
            await agent.processRequest(req.body);
            console.log('✅ Webhook processed successfully in background');
          } catch (processError) {
            console.error('❌ Error processing webhook in background:', processError);
          }
        })();
        
      } catch (error: any) {
        console.error('❌ Error handling webhook request:', error);
        // We only send error if we haven't responded yet
        if (!res.headersSent) {
          res.status(500).json({ 
            error: 'Internal server error',
            message: error.message
          });
        }
      }
    });

    app.get('/webhook', (req, res) => {
      res.send('✅ This endpoint works! Send a POST request from SuperDapp to interact.');
    });

    app.listen(PORT, () => {
      console.log(`🚀 Satoshin (Club Blockchain PUCP) agent is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
