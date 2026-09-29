const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const Wish = require('./models/Wish');
const Config = require('./models/Config');

const app = express();
const PORT = process.env.PORT || 5050;
const MONGODB_URI = process.env.MONGODB_URI || '';
const DEFAULT_PIN = process.env.ADMIN_PIN || '2026SF';

let isMongoConnected = false;

// Fallback In-Memory Storage for local testing without MongoDB installed
let memoryWishes = [];
let memoryConfig = {
  coverUrl: 'https://imagedelivery.net/pXU-KzWtO2cgM-XrR20TQg/9aa4c918-902d-4d87-bcda-abdbeddd0a00/public',
  bgmUrl: '',
  heroVideoUrl: 'assets/video.mp4',
  adminPin: DEFAULT_PIN
};

// Middleware
app.use(cors());
app.use(express.json());

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: isMongoConnected ? 'MongoDB Atlas' : 'In-Memory (Local)',
    timestamp: new Date()
  });
});

// GET Config
app.get('/api/config', async (req, res) => {
  try {
    if (isMongoConnected) {
      let config = await Config.findOne();
      if (!config) config = await Config.create({ adminPin: DEFAULT_PIN });
      return res.json({
        coverUrl: config.coverUrl,
        bgmUrl: config.bgmUrl,
        heroVideoUrl: config.heroVideoUrl
      });
    }
    res.json({
      coverUrl: memoryConfig.coverUrl,
      bgmUrl: memoryConfig.bgmUrl,
      heroVideoUrl: memoryConfig.heroVideoUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE Config (Admin)
app.post('/api/admin/config', async (req, res) => {
  try {
    const { pin, coverUrl, bgmUrl, heroVideoUrl } = req.body;
    const currentPin = isMongoConnected ? (await Config.findOne() || {}).adminPin || DEFAULT_PIN : memoryConfig.adminPin;

    if (pin !== currentPin) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    if (isMongoConnected) {
      let config = await Config.findOne();
      if (!config) config = new Config();
      if (coverUrl !== undefined) config.coverUrl = coverUrl;
      if (bgmUrl !== undefined) config.bgmUrl = bgmUrl;
      if (heroVideoUrl !== undefined) config.heroVideoUrl = heroVideoUrl;
      await config.save();
      return res.json({ message: 'Config updated in MongoDB', config });
    }

    if (coverUrl !== undefined) memoryConfig.coverUrl = coverUrl;
    if (bgmUrl !== undefined) memoryConfig.bgmUrl = bgmUrl;
    if (heroVideoUrl !== undefined) memoryConfig.heroVideoUrl = heroVideoUrl;
    res.json({ message: 'Config updated in memory', config: memoryConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Wishes (Paginated)
app.get('/api/wishes', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 6;
  const skip = (page - 1) * limit;

  try {
    if (isMongoConnected && mongoose.connection.readyState === 1) {
      const [wishes, total] = await Promise.all([
        Wish.find().sort({ createdAt: -1 }).skip(skip).limit(limit).maxTimeMS(3000).lean(),
        Wish.countDocuments().maxTimeMS(3000)
      ]);
      const formatted = wishes.map(w => ({
        key: w._id.toString(),
        name: w.name,
        msg: w.msg,
        time: w.time || (w.createdAt ? new Date(w.createdAt).toLocaleString() : ''),
        likes: w.likes || 0,
        reply: (w.reply && w.reply.msg) ? { msg: w.reply.msg, ts: w.reply.createdAt ? new Date(w.reply.createdAt).getTime() : Date.now() } : null,
        ts: w.createdAt ? new Date(w.createdAt).getTime() : Date.now()
      }));
      return res.json({ wishes: formatted, total, hasMore: skip + wishes.length < total });
    }

    const total = memoryWishes.length;
    const paginated = memoryWishes.slice(skip, skip + limit);
    res.json({ wishes: paginated, total, hasMore: skip + paginated.length < total });
  } catch (err) {
    console.warn('Wishes fetch fallback:', err.message);
    const total = memoryWishes.length;
    const paginated = memoryWishes.slice(skip, skip + limit);
    res.json({ wishes: paginated, total, hasMore: skip + paginated.length < total });
  }
});

// POST New Wish
app.post('/api/wishes', async (req, res) => {
  try {
    const { name, msg, time } = req.body;
    if (!name || !msg) {
      return res.status(400).json({ error: 'Name and message are required' });
    }

    const now = new Date();
    const formattedTime = time || (
      now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' +
      now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    );

    if (isMongoConnected) {
      const wish = await Wish.create({ name, msg, time: formattedTime });
      return res.status(201).json({
        key: wish._id.toString(),
        name: wish.name,
        msg: wish.msg,
        time: wish.time,
        likes: wish.likes,
        reply: null,
        ts: wish.createdAt.getTime()
      });
    }

    const newWish = {
      key: Date.now().toString(),
      name,
      msg,
      time: formattedTime,
      likes: 0,
      reply: null,
      ts: now.getTime()
    };
    memoryWishes.unshift(newWish);
    res.status(201).json(newWish);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LIKE A Wish
app.post('/api/wishes/:id/like', async (req, res) => {
  try {
    const id = req.params.id;
    if (isMongoConnected) {
      const wish = await Wish.findByIdAndUpdate(id, { $inc: { likes: 1 } }, { new: true });
      if (!wish) return res.status(404).json({ error: 'Wish not found' });
      return res.json({ key: wish._id.toString(), likes: wish.likes });
    }

    const wish = memoryWishes.find(w => w.key === id);
    if (!wish) return res.status(404).json({ error: 'Wish not found' });
    wish.likes = (wish.likes || 0) + 1;
    res.json({ key: wish.key, likes: wish.likes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: Reply to Wish
app.post('/api/wishes/:id/reply', async (req, res) => {
  try {
    const { pin, msg } = req.body;
    const currentPin = isMongoConnected ? (await Config.findOne() || {}).adminPin || DEFAULT_PIN : memoryConfig.adminPin;

    if (pin !== currentPin) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const id = req.params.id;
    if (isMongoConnected) {
      const wish = await Wish.findByIdAndUpdate(id, { reply: { msg, createdAt: new Date() } }, { new: true });
      if (!wish) return res.status(404).json({ error: 'Wish not found' });
      return res.json({ message: 'Reply saved', reply: wish.reply });
    }

    const wish = memoryWishes.find(w => w.key === id);
    if (!wish) return res.status(404).json({ error: 'Wish not found' });
    wish.reply = { msg, ts: Date.now() };
    res.json({ message: 'Reply saved in memory', reply: wish.reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: Remove Reply
app.delete('/api/wishes/:id/reply', async (req, res) => {
  try {
    const { pin } = req.body;
    const currentPin = isMongoConnected ? (await Config.findOne() || {}).adminPin || DEFAULT_PIN : memoryConfig.adminPin;

    if (pin !== currentPin) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const id = req.params.id;
    if (isMongoConnected) {
      const wish = await Wish.findByIdAndUpdate(id, { reply: { msg: '', createdAt: null } }, { new: true });
      if (!wish) return res.status(404).json({ error: 'Wish not found' });
      return res.json({ message: 'Reply removed' });
    }

    const wish = memoryWishes.find(w => w.key === id);
    if (!wish) return res.status(404).json({ error: 'Wish not found' });
    wish.reply = null;
    res.json({ message: 'Reply removed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`🚀 Express server running on http://localhost:${PORT}`);
});

// Connect to MongoDB Atlas (if MONGODB_URI is provided in .env)
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 10000
  })
    .then(() => {
      isMongoConnected = true;
      console.log('✅ Connected to MongoDB Atlas successfully');
    })
    .catch((err) => {
      isMongoConnected = false;
      console.warn('⚠️ MongoDB Connection Warning (Using in-memory storage fallback):', err.message);
    });

  mongoose.connection.on('disconnected', () => {
    isMongoConnected = false;
    console.warn('⚠️ MongoDB disconnected.');
  });
  mongoose.connection.on('reconnected', () => {
    isMongoConnected = true;
    console.log('✅ MongoDB reconnected.');
  });
} else {
  console.log('ℹ️ No MONGODB_URI set in backend/.env. Using local in-memory storage.');
}
