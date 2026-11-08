require('dotenv').config();
const bot = require('./telegram');
bot.start().catch(err=>{console.error('[startup] fatal:',err);process.exit(1);});
