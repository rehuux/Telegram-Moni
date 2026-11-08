const mongoose = require('mongoose');
const subscriptionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  chatId: { type: String, required: true },
  username: { type: String, required: true, lowercase: true },
  mode: { type: String, enum: ['ban', 'unban', 'followers', 'verify'], default: 'ban' },
  status: { type: String, enum: ['active', 'banned', 'paused'], default: 'active' },
  followers: { type: Number, default: 0 },
  threshold: { type: Number, default: 0 },
  startedAt: { type: Date, default: Date.now },
  lastCheckedAt: Date
}, { timestamps: true });
subscriptionSchema.index({ userId: 1, username: 1, mode: 1 }, { unique: true });
subscriptionSchema.index({ username: 1, status: 1 });
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  chatId: { type: String, required: true },
  username: String,
  dmEnabled: { type: Boolean, default: true },
  premiumUntil: { type: Date, default: null },
  blocked: { type: Boolean, default: false }
}, { timestamps: true });
const historySchema = new mongoose.Schema({
  username: String, event: String, detail: String, timestamp: { type: Date, default: Date.now }
});
const Subscription = mongoose.models.TelegramSubscription || mongoose.model('TelegramSubscription', subscriptionSchema);
const TgUser = mongoose.models.TelegramUser || mongoose.model('TelegramUser', userSchema);
const History = mongoose.models.TelegramHistory || mongoose.model('TelegramHistory', historySchema);
async function connect() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  console.log('[DB] MongoDB connected');
}
module.exports = {
  connect,
  findUser: (userId) => TgUser.findOne({ userId }).lean(),
  registerUser: (userId, chatId, username) => TgUser.findOneAndUpdate({ userId }, { userId, chatId, username }, { upsert: true, new: true }),
  addWatch: async (userId, chatId, username, mode='ban', followers=0, threshold=0) => Subscription.findOneAndUpdate({ userId, username, mode }, { userId, chatId, username, mode, status: mode === 'unban' ? 'banned' : 'active', followers: Number(followers)||0, threshold: Number(threshold)||0, startedAt: new Date() }, { upsert: true, new: true }),
  removeWatch: (userId, username, mode) => Subscription.deleteMany({ userId, username, ...(mode ? {mode} : {}) }),
  getUserWatches: (userId) => Subscription.find({ userId }).sort({ createdAt: -1 }).lean(),
  getAllActiveWatches: () => Subscription.find({ status: { $ne: 'paused' } }).lean(),
  setPaused: (userId, username, paused) => Subscription.updateMany({ userId, username }, { status: paused ? 'paused' : 'active' }),
  updateModeStatus: (username, mode, status, followers) => Subscription.updateMany({ username, mode, status: { $ne: 'paused' } }, { $set: { status, ...(followers != null ? { followers: Number(followers)||0 } : {}) } }),
  getSubscribers: (username, mode) => Subscription.find({ username, mode, status: { $ne: 'paused' } }).lean(),
  updateFollowerBaseline: (userId, username, followers) => Subscription.updateOne({ userId, username, mode: 'followers' }, { followers: Number(followers)||0 }),
  log: (username, event, detail='') => History.create({ username, event, detail }),
  getHistory: (username) => History.find({ username }).sort({ timestamp: -1 }).limit(20).lean(),
  stats: async () => ({ users: await TgUser.countDocuments(), subscriptions: await Subscription.countDocuments(), active: await Subscription.countDocuments({status:{$ne:'paused'}}), events: await History.countDocuments() }),
  setDm: (userId, enabled) => TgUser.updateOne({ userId }, { dmEnabled: enabled }),
  setPremium: (userId, days) => TgUser.updateOne({ userId }, { premiumUntil: days ? new Date(Date.now()+days*86400000) : null }, { upsert: true }),
  isPremium: async (userId) => { const u=await TgUser.findOne({userId}).lean(); return !!u && (!u.premiumUntil || u.premiumUntil > new Date()); },
  getUsers: () => TgUser.find().lean(),
  countUsers: () => TgUser.countDocuments()
};
