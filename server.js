const express=require('express');
const session=require('express-session');
const PgSession=require('connect-pg-simple')(session);
const {Pool}=require('pg');
const crypto=require('crypto');
const cors=require('cors');
const path=require('path');
const {Client,GatewayIntentBits,REST,Routes,SlashCommandBuilder,PermissionFlagsBits,EmbedBuilder}=require('discord.js');
const required=['DATABASE_URL','DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','SESSION_SECRET','TOKEN_ENCRYPTION_KEY','OWNER_DISCORD_ID','WEB_ORIGIN'];
for(const key of required)if(!process.env[key])console.warn('Missing environment variable:',key);
const app=express(),port=process.env.PORT||3000;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});
pool.on('error',e=>console.error('Postgres pool error:',e.message));
async function init(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
 await pool.query('CREATE TABLE IF NOT EXISTS bot_manager_bots(id TEXT PRIMARY KEY,application_id TEXT NOT NULL,name TEXT NOT NULL,owner_id TEXT NOT NULL,owner_name TEXT NOT NULL,token_cipher TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
 await pool.query('CREATE INDEX IF NOT EXISTS idx_bot_manager_bots_owner ON bot_manager_bots(owner_id)');
 await pool.query("CREATE TABLE IF NOT EXISTS bot_manager_welcome_settings(bot_id TEXT NOT NULL REFERENCES bot_manager_bots(id) ON DELETE CASCADE,guild_id TEXT NOT NULL,channel_id TEXT,message TEXT NOT NULL DEFAULT 'Welcome {user} to {server}! You are member #{memberCount}.',enabled BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(bot_id,guild_id))");
}
function encKey(){const raw=process.env.TOKEN_ENCRYPTION_KEY||'';if(!/^[a-fA-F0-9]{64}$/.test(raw))throw new Error('Server encryption key is not configured.');return Buffer.from(raw,'hex')}
function encrypt(s){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',encKey(),iv),v=Buffer.concat([c.update(s,'utf8'),c.final()]);return [iv.toString('hex'),c.getAuthTag().toString('hex'),v.toString('hex')].join(':')}
function decrypt(s){const [iv,tag,data]=s.split(':'),d=crypto.createDecipheriv('aes-256-gcm',encKey(),Buffer.from(iv,'hex'));d.setAuthTag(Buffer.from(tag,'hex'));return Buffer.concat([d.update(Buffer.from(data,'hex')),d.final()]).toString('utf8')}
app.set('trust proxy',1);app.use(cors({origin:process.env.WEB_ORIGIN,credentials:true}));app.use(express.json({limit:'16kb'}));
app.use(session({store:new PgSession({pool,tableName:'bot_manager_sessions',createTableIfMissing:true}),secret:process.env.SESSION_SECRET||'configure-session-secret',resave:false,saveUninitialized:false,cookie:{httpOnly:true,secure:true,sameSite:'none',maxAge:604800000}}));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/bot-manager.html',(req,res)=>res.sendFile(path.join(__dirname,'bot-manager.html')));
const auth=(req,res,next)=>req.session.user?next():res.status(401).json({error:'Sign in with Discord first.'});
const owner=req=>req.session.user?.id===process.env.OWNER_DISCORD_ID;
async function ownedBot(req){const q=await pool.query('SELECT * FROM bot_manager_bots WHERE id=$1',[req.params.id]),b=q.rows[0];if(!b)return{error:'Bot not found.',status:404};if(b.owner_id!==req.session.user.id&&!owner(req))return{error:'You cannot access this bot.',status:403};return{bot:b}}
async function discord(pathname,token){const r=await fetch('https://discord.com/api/v10'+pathname,{headers:{Authorization:'Bot '+token}}),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Discord API request failed.');return d}
const runtimes=new Map();
const welcomeCommand=new SlashCommandBuilder().setName('welcome').setDescription('Configure this server welcome message')
 .addSubcommand(sc=>sc.setName('setup').setDescription('Choose the welcome channel').addChannelOption(o=>o.setName('channel').setDescription('Welcome channel').setRequired(true)))
 .addSubcommand(sc=>sc.setName('message').setDescription('Change the welcome message').addStringOption(o=>o.setName('text').setDescription('Use {user}, {server}, {memberCount}').setMaxLength(1800).setRequired(true)))
 .addSubcommand(sc=>sc.setName('disable').setDescription('Turn welcome messages off'))
 .addSubcommand(sc=>sc.setName('enable').setDescription('Turn welcome messages on'))
 .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
async function getWelcome(botId,guildId){const q=await pool.query('SELECT channel_id AS "channelId",message,enabled FROM bot_manager_welcome_settings WHERE bot_id=$1 AND guild_id=$2',[botId,guildId]);return q.rows[0]||{channelId:null,message:'Welcome {user} to {server}! You are member #{memberCount}.',enabled:true}}
async function saveWelcome(botId,guildId,values){const old=await getWelcome(botId,guildId),next={...old,...values};await pool.query('INSERT INTO bot_manager_welcome_settings(bot_id,guild_id,channel_id,message,enabled,updated_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(bot_id,guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,message=EXCLUDED.message,enabled=EXCLUDED.enabled,updated_at=NOW()',[botId,guildId,next.channelId,next.message,next.enabled]);return next}
const { fork } = require('child_process');
const runtimes = new Map();
function startBot(row) {
  if(runtimes.has(row.id)) return Promise.resolve();
  const token=decrypt(row.token_cipher);
  const dataDir=path.join('/tmp','forsaken-manager',row.id);
  fs.mkdirSync(dataDir,{recursive:true});
  const child=fork(path.join(__dirname,'forsaken-worker.js'),[],{env:{...process.env,DISCORD_TOKEN:token,BOT_MANAGER_BOT_ID:row.id,DATA_DIR:dataDir,PORT:'0'},stdio:['ignore','pipe','pipe','ipc']});
  const runtime={child,status:'starting',guilds:[],commands:[]};runtimes.set(row.id,runtime);
  child.stdout.on('data',b=>console.log('[bot '+row.id+'] '+b.toString().trim()));
  child.stderr.on('data',b=>console.error('[bot '+row.id+'] '+b.toString().trim()));
  child.on('message',msg=>{if(msg?.type==='snapshot'){runtime.guilds=msg.guilds||[];runtime.commands=msg.commands||[];runtime.status='online';}});
  child.on('exit',code=>{runtime.status='offline';runtime.exitCode=code;});
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();runtimes.delete(row.id);reject(new Error('Bot startup timed out. Check the token and enabled Discord intents.'));},60000);
    const onMessage=msg=>{if(msg?.type==='snapshot'){clearTimeout(timeout);child.removeListener('message',onMessage);runtime.guilds=msg.guilds||[];runtime.commands=msg.commands||[];runtime.status='online';resolve();}};
    child.on('message',onMessage);
    child.once('exit',code=>{clearTimeout(timeout);child.removeListener('message',onMessage);if(runtime.status!=='online'){runtimes.delete(row.id);reject(new Error('Bot worker exited before becoming ready (code '+code+').'));}});
  });
}
async function stopBot(id){const runtime=runtimes.get(id);if(runtime){runtimes.delete(id);runtime.child.kill('SIGTERM');}}
async function stopBot(id){const rt=runtimes.get(id);if(rt){runtimes.delete(id);await rt.client.destroy()}}
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:'connected',activeBots:runtimes.size})}catch(e){res.status(503).json({ok:false,database:'unavailable'})}});
app.get('/auth/discord',(req,res)=>{const state=crypto.randomBytes(24).toString('hex');req.session.oauthState=state;const u=new URL('https://discord.com/oauth2/authorize');u.searchParams.set('client_id',process.env.DISCORD_CLIENT_ID||'');u.searchParams.set('redirect_uri',process.env.DISCORD_REDIRECT_URI||'https://forsaken-bot-manager-b9vd.onrender.com/auth/discord/callback');u.searchParams.set('response_type','code');u.searchParams.set('scope','identify');u.searchParams.set('state',state);res.redirect(u.toString())});
app.get('/auth/discord/callback',async(req,res)=>{try{if(!req.query.code||req.query.state!==req.session.oauthState)throw Error('Discord sign-in state check failed.');delete req.session.oauthState;const redirect=process.env.DISCORD_REDIRECT_URI||'https://forsaken-bot-manager-b9vd.onrender.com/auth/discord/callback';const form=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code:String(req.query.code),redirect_uri:redirect});const tr=await fetch('https://discord.com/api/v10/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form}),td=await tr.json();if(!tr.ok)throw Error('Discord sign-in exchange failed.');const ur=await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:'Bearer '+td.access_token}}),u=await ur.json();if(!ur.ok)throw Error('Could not verify Discord account.');req.session.user={id:u.id,username:u.global_name||u.username};res.redirect('https://forsaken-bot-manager-b9vd.onrender.com/bot-manager.html')}catch(e){res.status(400).send('Discord sign-in failed: '+String(e.message).replace(/[<>]/g,''))}});
app.post('/auth/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',auth,(req,res)=>res.json({user:{id:req.session.user.id,username:req.session.user.username,isOwner:owner(req)}}));
app.get('/api/bots',auth,async(req,res)=>{try{const q=owner(req)?await pool.query('SELECT id,application_id AS "applicationId",name,owner_id AS "ownerId",owner_name AS "ownerName",created_at AS "createdAt" FROM bot_manager_bots ORDER BY created_at DESC'):await pool.query('SELECT id,application_id AS "applicationId",name,owner_id AS "ownerId",owner_name AS "ownerName",created_at AS "createdAt" FROM bot_manager_bots WHERE owner_id=$1 ORDER BY created_at DESC',[req.session.user.id]);res.json({bots:q.rows.map(b=>({...b,status:runtimes.get(b.id)?.status||'offline'}))})}catch(e){res.status(503).json({error:'Database is not ready. Check DATABASE_URL in Render.'})}});
app.post('/api/bots',auth,async(req,res)=>{let id;try{const token=String(req.body.token||'').trim();if(token.length<30||token.length>200)return res.status(400).json({error:'That token does not look valid.'});const a=await discord('/oauth2/applications/@me',token);if(!a.id)throw Error('Discord did not return a bot application.');id=crypto.randomUUID();const cipher=encrypt(token);await pool.query('INSERT INTO bot_manager_bots(id,application_id,name,owner_id,owner_name,token_cipher) VALUES($1,$2,$3,$4,$5,$6)',[id,a.id,a.name||'Discord bot',req.session.user.id,req.session.user.username,cipher]);await startBot({id,token_cipher:cipher});res.status(201).json({bot:{id,applicationId:a.id,name:a.name||'Discord bot',status:'online'}})}catch(e){if(id)await pool.query('DELETE FROM bot_manager_bots WHERE id=$1',[id]).catch(()=>{});res.status(400).json({error:e.message||'Could not connect bot.'})}});
app.post('/api/bots/:id/reconnect',auth,async(req,res)=>{const a=await ownedBot(req);if(a.error)return res.status(a.status).json({error:a.error});try{await stopBot(req.params.id);await startBot(a.bot);res.json({ok:true,status:'online'})}catch(e){res.status(400).json({error:e.message||'Could not reconnect bot.'})}});
app.get('/api/bots/:id/guilds',auth,async(req,res)=>{const a=await ownedBot(req);if(a.error)return res.status(a.status).json({error:a.error});const rt=runtimes.get(req.params.id);if(!rt||rt.status!=='online')return res.status(409).json({error:'Bot is offline. Reconnect it from the dashboard.'});res.json({guilds:[...rt.client.guilds.cache.values()].map(g=>({id:g.id,name:g.name,memberCount:g.memberCount})).sort((x,y)=>x.name.localeCompare(y.name))})});
app.get('/api/bots/:id/guilds/:guildId/channels',auth,async(req,res)=>{const a=await ownedBot(req);if(a.error)return res.status(a.status).json({error:a.error});const g=runtimes.get(req.params.id)?.client.guilds.cache.get(req.params.guildId);if(!g)return res.status(404).json({error:'Server is not available to this bot.'});res.json({channels:[...g.channels.cache.values()].filter(c=>c.isTextBased()&&c.guildId===g.id).map(c=>({id:c.id,name:c.name}))})});
app.get('/api/bots/:id/guilds/:guildId/welcome',auth,async(req,res)=>{const a=await ownedBot(req);if(a.error)return res.status(a.status).json({error:a.error});const rt=runtimes.get(req.params.id);if(!rt?.client.guilds.cache.has(req.params.guildId))return res.status(404).json({error:'Server is not available to this bot.'});res.json({settings:await getWelcome(req.params.id,req.params.guildId)})});
app.put('/api/bots/:id/guilds/:guildId/welcome',auth,async(req,res)=>{const a=await ownedBot(req);if(a.error)return res.status(a.status).json({error:a.error});const rt=runtimes.get(req.params.id),g=rt?.client.guilds.cache.get(req.params.guildId);if(!g)return res.status(404).json({error:'Server is not available to this bot.'});const message=String(req.body.message||'').trim(),channelId=req.body.channelId?String(req.body.channelId):null,enabled=req.body.enabled!==false;if(!message||message.length>1800)return res.status(400).json({error:'Message must be 1–1800 characters.'});if(channelId&&!g.channels.cache.has(channelId))return res.status(400).json({error:'Choose a channel from this server.'});res.json({settings:await saveWelcome(req.params.id,req.params.guildId,{message,channelId,enabled})})});
app.get('/api/bots/:id/commands',auth,async(req,res)=>{const a=await ownedBot(req);if(a.error)return res.status(a.status).json({error:a.error});const rt=runtimes.get(req.params.id);try{const c=rt?.client.application?.commands?await rt.client.application.commands.fetch():[];res.json({commands:[...c.values()].map(x=>({id:x.id,name:x.name,description:x.description,type:x.type}))})}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/bots/:id',auth,async(req,res)=>{const a=await ownedBot(req);if(a.error)return res.status(a.status).json({error:a.error});await stopBot(req.params.id);await pool.query('DELETE FROM bot_manager_bots WHERE id=$1',[req.params.id]);res.json({ok:true})});
init().then(async()=>{const rows=await pool.query('SELECT id,token_cipher FROM bot_manager_bots');for(const row of rows.rows)startBot(row).catch(e=>console.error('Saved bot reconnect failed '+row.id,e.message));app.listen(port,'0.0.0.0',()=>console.log('Forsaken Bot Manager listening on '+port))}).catch(e=>{console.error('Database initialization failed:',e.message);app.listen(port,'0.0.0.0',()=>console.log('API started without database'))});
