require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./telegram-db');
const ig = require('./instagram');
const { setTimeout: delay } = require('timers/promises');
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const OWNERS = (process.env.OWNER_IDS || process.env.OWNER_ID_1 || '').split(',').map(x=>x.trim()).filter(Boolean);
const CHECK_INTERVAL = Math.max(300000, Number(process.env.CHECK_INTERVAL_MS) || 900000);
const MAX_USERS = Number(process.env.MAX_REGISTERED_USERS) || 2000;
const MAX_WATCHES_PER_USER = Number(process.env.MAX_WATCHES_PER_USER) || 10;
const bot = new Telegraf(TOKEN);
const started = Date.now();
let maintenance = false;
let workerBusy = false;
const isOwner = ctx => OWNERS.includes(String(ctx.from?.id));
bot.use(async (ctx, next) => { if (maintenance && !isOwner(ctx)) { if (ctx.chat?.id) await ctx.reply('Bot is under maintenance.'); return; } return next(); });
const usernameOf = s => String(s||'').trim().replace(/^@/, '').toLowerCase();
const validUsername = s => /^[a-z0-9._]{1,30}$/.test(s);
const fmt = n => Number(n||0).toLocaleString('en-US');
const timeTaken = d => { const sec=Math.max(0,Math.floor((Date.now()-new Date(d).getTime())/1000)); const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60; return [h&&`${h}h`,m&&`${m}m`,`${s}s`].filter(Boolean).join(' '); };
async function reply(ctx, text, extra={}) { return ctx.reply(text, { parse_mode:'HTML', ...extra }); }
async function register(ctx) {
  const uid=String(ctx.from.id); const count=await db.countUsers();
  const exists=!!(await db.findUser(uid));
  if (!exists && count>=MAX_USERS && !isOwner(ctx)) throw new Error('Bot registration is currently full.');
  await db.registerUser(uid, String(ctx.chat.id), ctx.from.username || ctx.from.first_name || '');
}
async function addWatch(ctx, mode, username) {
  username=usernameOf(username);
  if (!validUsername(username)) return reply(ctx,'Usage: <code>/watch username</code>');
  const userId=String(ctx.from.id); const watches=await db.getUserWatches(userId);
  if (!watches.some(w=>w.username===username) && watches.length>=MAX_WATCHES_PER_USER && !isOwner(ctx)) return reply(ctx,`Limit: ${MAX_WATCHES_PER_USER} tracked profiles per user.`);
  const info=await ig.check(username);
  if (!info) return reply(ctx,'Instagram returned an unknown/blocked response. No watch was created; try later.');
  if (mode==='ban' && info.banned) return reply(ctx,`@${username} appears unavailable already. Use /unbanwatch if you want recovery monitoring.`);
  if (mode==='unban' && !info.banned) return reply(ctx,`@${username} appears active already. Use /watch for ban monitoring.`);
  await db.addWatch(userId,String(ctx.chat.id),username,mode,info.followers||0);
  await db.log(username,`${mode}_watch_added`,`by ${userId}`);
  return reply(ctx,`✅ Monitoring <b>@${username}</b> for ${mode==='ban'?'ban':'recovery'}.\nFollowers: ${fmt(info.followers)} · Following: ${fmt(info.following)}\nCheck interval: ${Math.round(CHECK_INTERVAL/60000)} min`);
}

bot.start(async ctx=>{ try { await register(ctx); await reply(ctx,'<b>IG-MONI Telegram</b>\nInstagram account monitoring bot.\n\n/watch username — monitor ban\n/unbanwatch username — monitor recovery\n/check username — check profile\n/watchlist — your watches\n/unwatch username — remove watch\n/help — all commands'); } catch(e){ await reply(ctx,e.message); } });
bot.command('help',ctx=>reply(ctx,'<b>Commands</b>\n/watch username\n/unbanwatch username\n/check username\n/status username\n/watchlist\n/unwatch username\n/pause username\n/resume username\n/followers username threshold\n/history username\n/stats\n/dmon or /dmoff\n\nOwner: /mon, /moff, /givepremium userId [days], /setinterval minutes'));
bot.command('watch',async ctx=>{await register(ctx); return addWatch(ctx,'ban',ctx.message.text.split(/\s+/)[1]);});
bot.command('banwatch',async ctx=>{await register(ctx); return addWatch(ctx,'ban',ctx.message.text.split(/\s+/)[1]);});
bot.command('unbanwatch',async ctx=>{await register(ctx); return addWatch(ctx,'unban',ctx.message.text.split(/\s+/)[1]);});
bot.command('check',async ctx=>{await register(ctx); const u=usernameOf(ctx.message.text.split(/\s+/)[1]); if(!validUsername(u)) return reply(ctx,'Usage: /check username'); await ctx.reply(`⏳ Checking @${u}…`); const x=await ig.check(u); if(!x) return reply(ctx,'Could not reliably fetch this profile. Status is UNKNOWN, not banned.'); return reply(ctx,`${x.banned?'🔴 Unavailable':'🟢 Active'} <b>@${u}</b>\nFollowers: ${fmt(x.followers)}\nFollowing: ${fmt(x.following)}\nPosts: ${fmt(x.posts)}\nhttps://instagram.com/${u}/`);});
bot.command('status',async ctx=>{const u=usernameOf(ctx.message.text.split(/\s+/)[1]); if(!validUsername(u)) return reply(ctx,'Usage: /status username'); const x=await ig.check(u); if(!x) return reply(ctx,'Status UNKNOWN: Instagram did not return reliable data.'); return reply(ctx,`${x.banned?'🔴 Unavailable':'🟢 Active'} @${u}\nFollowers: ${fmt(x.followers)} · Following: ${fmt(x.following)}`);});
bot.command('watchlist',async ctx=>{await register(ctx); const ws=await db.getUserWatches(String(ctx.from.id)); if(!ws.length) return reply(ctx,'Your watchlist is empty.'); return reply(ctx,ws.map(w=>`${w.status==='paused'?'⏸':'👁'} @${w.username} — ${w.mode} (${w.status})`).join('\n'));});
bot.command('unwatch',async ctx=>{await register(ctx); const u=usernameOf(ctx.message.text.split(/\s+/)[1]); if(!validUsername(u)) return reply(ctx,'Usage: /unwatch username'); await db.removeWatch(String(ctx.from.id),u); return reply(ctx,`Removed your subscriptions for @${u}.`);});
for (const [cmd, paused] of [['pause',true],['resume',false]]) bot.command(cmd,async ctx=>{await register(ctx); const u=usernameOf(ctx.message.text.split(/\s+/)[1]); if(!validUsername(u)) return reply(ctx,`Usage: /${cmd} username`); await db.setPaused(String(ctx.from.id),u,paused); return reply(ctx,`${paused?'Paused':'Resumed'} @${u}.`);});
bot.command('followers',async ctx=>{await register(ctx); const [,raw,thresholdRaw]=ctx.message.text.split(/\s+/); const u=usernameOf(raw); const threshold=Number(thresholdRaw); if(!validUsername(u)||!Number.isInteger(threshold)||threshold<1) return reply(ctx,'Usage: /followers username threshold'); const x=await ig.check(u); if(!x||x.banned) return reply(ctx,'Profile data unavailable; follower tracking not started.'); await db.addWatch(String(ctx.from.id),String(ctx.chat.id),u,'followers',x.followers,threshold); return reply(ctx,`Follower alerts enabled for @${u}; threshold ${fmt(threshold)}.`);});
bot.command('history',async ctx=>{const u=usernameOf(ctx.message.text.split(/\s+/)[1]); if(!validUsername(u)) return reply(ctx,'Usage: /history username'); const rows=await db.getHistory(u); return reply(ctx,rows.length?rows.map(x=>`${new Date(x.timestamp).toLocaleString()} — ${x.event} ${x.detail||''}`).join('\n'):'No history.');});
bot.command('stats',async ctx=>{const s=await db.stats(); return reply(ctx,`<b>IG-MONI Stats</b>\nUsers: ${s.users}\nSubscriptions: ${s.subscriptions}\nActive subscriptions: ${s.active}\nEvents: ${s.events}\nUptime: ${timeTaken(started)}`);});
bot.command('dmon',async ctx=>{await register(ctx); return reply(ctx,'Telegram notifications are enabled by default for this chat.');});
bot.command('dmoff',async ctx=>{await db.setDm(String(ctx.from.id),false); return reply(ctx,'Notifications preference saved. (Monitoring alerts will be suppressed.)');});
bot.command('mon',async ctx=>{if(!isOwner(ctx)) return; maintenance=true; return reply(ctx,'Maintenance mode enabled.');});
bot.command('moff',async ctx=>{if(!isOwner(ctx)) return; maintenance=false; return reply(ctx,'Maintenance mode disabled.');});
bot.command('givepremium',async ctx=>{if(!isOwner(ctx)) return; const [,id,daysRaw]=ctx.message.text.split(/\s+/); if(!id) return reply(ctx,'Usage: /givepremium userId [days]'); await db.setPremium(id,Number(daysRaw)||0); return reply(ctx,`Premium updated for ${id}.`);});
bot.command('setinterval',async ctx=>{if(!isOwner(ctx)) return; return reply(ctx,'Set CHECK_INTERVAL_MS in deployment environment and restart. Minimum supported interval is 5 minutes.');});
bot.command('ping',ctx=>reply(ctx,`Pong · ${Date.now()-ctx.message.date*1000}ms`));
bot.command('uptime',ctx=>reply(ctx,`Uptime: ${timeTaken(started)}`));
bot.command('botinfo',ctx=>reply(ctx,'IG-MONI Telegram edition · MongoDB + Puppeteer/Chromium'));
bot.command('price',ctx=>reply(ctx,process.env.PREMIUM_PRICE_TEXT || 'Contact bot owner for premium pricing.'));
bot.on('text',async ctx=>{ if(maintenance&&!isOwner(ctx)) return reply(ctx,'Bot is under maintenance.'); });
bot.catch((err,ctx)=>{console.error('[telegram] handler error',err); ctx.reply('An internal error occurred. Please retry later.').catch(()=>{});});

async function sendAlert(sub, text) {
  try { const user = await db.findUser(sub.userId); if (user && user.dmEnabled === false) return; await bot.telegram.sendMessage(sub.chatId,text,{parse_mode:'HTML',disable_web_page_preview:true}); }
  catch(e) { if (e.response?.error_code===403) console.warn(`[telegram] user blocked bot: ${sub.userId}`); else console.warn('[telegram] send alert failed:',e.message); }
}
async function workerCycle() {
  if(workerBusy||maintenance) return; workerBusy=true;
  try {
    const all=await db.getAllActiveWatches();
    const byUsername=new Map(); for(const sub of all){ if(!byUsername.has(sub.username)) byUsername.set(sub.username,[]); byUsername.get(sub.username).push(sub); }
    for(const [username,subs] of byUsername){
      const info=await ig.check(username);
      if(!info) { await delay(1500); continue; }
      for(const sub of subs){
        if(sub.mode==='ban' && info.banned && sub.status==='active'){
          await db.updateModeStatus(username,'ban','banned'); await db.log(username,'banned');
          const recipients=await db.getSubscribers(username,'ban'); for(const r of recipients) await sendAlert(r,`🔥 <b>@${username} has become unavailable</b>\nPrevious monitoring duration: ${timeTaken(sub.startedAt)}\nhttps://instagram.com/${username}/`);
        } else if(sub.mode==='unban' && !info.banned && sub.status==='banned'){
          await db.updateModeStatus(username,'unban','active',info.followers); await db.log(username,'recovered');
          const recipients=await db.getSubscribers(username,'unban'); for(const r of recipients) await sendAlert(r,`✅ <b>@${username} is active again</b>\nFollowers: ${fmt(info.followers)}\nhttps://instagram.com/${username}/`);
        } else if(sub.mode==='followers' && info.followers){
          const current=Number(info.followers), previous=Number(sub.followers||0);
          if(Math.abs(current-previous)>=Number(sub.threshold||1)){ await db.updateFollowerBaseline(sub.userId,username,current); await sendAlert(sub,`📊 <b>Follower change: @${username}</b>\n${fmt(previous)} → ${fmt(current)} (${current>previous?'+':''}${fmt(current-previous)})`); }
        }
      }
      await delay(1000);
    }
  } catch(e){console.error('[worker] cycle failed:',e);} finally{workerBusy=false;}
}
async function start(){if(!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing'); await db.connect(); await bot.launch({dropPendingUpdates:true}); console.log('[telegram] Bot started'); workerCycle().catch(console.error); const timer=setInterval(()=>workerCycle().catch(console.error),CHECK_INTERVAL); const stop=async signal=>{clearInterval(timer); console.log(`[shutdown] ${signal}`); await bot.stop(signal); await ig.closeSharedBrowser(); process.exit(0);}; process.once('SIGINT',()=>stop('SIGINT')); process.once('SIGTERM',()=>stop('SIGTERM'));}
module.exports={start};
