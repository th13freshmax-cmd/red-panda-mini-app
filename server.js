const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
//  IN-MEMORY STORE  (সার্ভার restart করলে data মুছে যাবে)
//  Production-এ MongoDB / PostgreSQL ব্যবহার করুন।
// ============================================================
const users = {}; // key: telegram userId (string)

// ---- Game config (frontend-এর সাথে মিল রাখুন) ----
const LEVELS = [
  { name: "Cub",          threshold: 0,       perTapBonus: 0 },
  { name: "Climber",      threshold: 50000,   perTapBonus: 1 },
  { name: "Forager",      threshold: 250000,  perTapBonus: 2 },
  { name: "Canopy Elder", threshold: 1000000, perTapBonus: 4 },
  { name: "Legend",       threshold: 5000000, perTapBonus: 8 },
];

const UPGRADES = {
  multitap:    { baseCost: 1000, costGrowth: 1.5, perLevelBonus: 1 },
  energyLimit: { baseCost: 1500, costGrowth: 1.6, perLevelBonus: 500 },
};

const CARDS = [
  { id: "bamboo_farm",      name: "Bamboo Farm",            category: "Markets",  basePph: 5,    baseCost: 1000,   costGrowth: 1.35 },
  { id: "honey_stand",      name: "Honey Stand",            category: "Markets",  basePph: 12,   baseCost: 3000,   costGrowth: 1.35 },
  { id: "bark_exchange",    name: "Bark Exchange",          category: "Markets",  basePph: 30,   baseCost: 9000,   costGrowth: 1.35 },
  { id: "social_team",      name: "Social Media Team",      category: "PR & Team",basePph: 25,   baseCost: 8000,   costGrowth: 1.4  },
  { id: "community_mods",   name: "Community Moderators",   category: "PR & Team",basePph: 60,   baseCost: 20000,  costGrowth: 1.4  },
  { id: "influencer_deal",  name: "Influencer Deal",        category: "PR & Team",basePph: 140,  baseCost: 55000,  costGrowth: 1.4  },
  { id: "legal_advisor",    name: "Legal Advisor",          category: "Legal",    basePph: 150,  baseCost: 50000,  costGrowth: 1.45 },
  { id: "compliance_audit", name: "Compliance Audit",       category: "Legal",    basePph: 400,  baseCost: 120000, costGrowth: 1.45 },
  { id: "frost_relic",      name: "Frost Relic",            category: "Specials", basePph: 1000, baseCost: 500000, costGrowth: 1.5  },
  { id: "golden_bamboo",    name: "Golden Bamboo",          category: "Specials", basePph: 3000, baseCost: 2000000,costGrowth: 1.5  },
];

const TASKS = [
  { id: "join_channel", title: "Join our Telegram channel", reward: 5000, type: "telegram_join", channelUsername: "@YourChannelUsername" },
  { id: "follow_x",    title: "Follow on X (Twitter)",     reward: 3000, type: "link", url: "https://x.com/yourproject" },
  { id: "join_chat",   title: "Join the community chat",   reward: 3000, type: "link", url: "https://t.me/yourcommunitychat" },
];

const DAILY_REWARD   = 5000;
const MAX_ENERGY_BASE = 1000;
const ENERGY_REGEN_RATE = 1; // per 3 seconds
const ENERGY_REGEN_MS   = 3000;

// ---- Helper functions ----
function getLevel(lifetimeEarned) {
  let lvl = LEVELS[0];
  for (const l of LEVELS) if (lifetimeEarned >= l.threshold) lvl = l;
  return lvl;
}

function upgradeCost(key, currentLevel) {
  const c = UPGRADES[key];
  return Math.round(c.baseCost * Math.pow(c.costGrowth, currentLevel));
}

function cardCost(card, level) {
  return Math.round(card.baseCost * Math.pow(card.costGrowth, level));
}

function totalPph(cards) {
  return CARDS.reduce((sum, c) => sum + c.basePph * (cards[c.id] || 0), 0);
}

function perTap(user) {
  const bonus = getLevel(user.lifetimeEarned).perTapBonus;
  return 1 + bonus + user.multitapLevel * UPGRADES.multitap.perLevelBonus;
}

function maxEnergy(user) {
  return MAX_ENERGY_BASE + user.energyLimitLevel * UPGRADES.energyLimit.perLevelBonus;
}

// Passive energy regen since last seen
function regenEnergy(user) {
  const now = Date.now();
  const elapsed = now - user.lastSeen;
  const ticks = Math.floor(elapsed / ENERGY_REGEN_MS);
  const max = maxEnergy(user);
  user.energy = Math.min(max, user.energy + ticks * ENERGY_REGEN_RATE);
  user.lastSeen = now;
}

// Passive income since last seen
function applyPassiveIncome(user) {
  const now = Date.now();
  const elapsedHours = (now - user.lastSeen) / 3600000;
  const pph = totalPph(user.cards);
  if (pph > 0 && elapsedHours > 0) {
    const earned = Math.floor(pph * elapsedHours);
    user.balance += earned;
    user.lifetimeEarned += earned;
  }
}

function getOrCreateUser(userId, ref) {
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      balance: 0,
      lifetimeEarned: 0,
      energy: MAX_ENERGY_BASE,
      multitapLevel: 0,
      energyLimitLevel: 0,
      cards: {},          // cardId -> level
      completedTasks: [], // taskIds
      referrals: [],
      referredBy: ref || null,
      lastDailyClaim: 0,
      lastSeen: Date.now(),
    };

    // Referral bonus
    if (ref && users[ref] && ref !== userId) {
      users[ref].balance += 5000;
      users[ref].lifetimeEarned += 5000;
      users[ref].referrals.push(userId);
    }
  }
  return users[userId];
}

function publicState(user) {
  return {
    balance: Math.floor(user.balance),
    energy: Math.floor(user.energy),
    maxEnergy: maxEnergy(user),
    pph: totalPph(user.cards),
    referralCount: user.referrals.length,
    canClaimDaily: Date.now() - user.lastDailyClaim >= 24 * 60 * 60 * 1000,
  };
}

// ---- Telegram initData থেকে userId বের করা ----
function getUserIdFromRequest(req) {
  const initData = req.headers["x-telegram-init-data"] || "";

  if (initData) {
    try {
      const params = new URLSearchParams(initData);
      const userStr = params.get("user");
      if (userStr) {
        const u = JSON.parse(decodeURIComponent(userStr));
        if (u && u.id) return String(u.id);
      }
    } catch (_) {}
  }

  // Fallback: query param (testing এর জন্য)
  const qId = req.query.user_id || req.body?.user_id;
  if (qId) return String(qId);

  return null;
}

// ============================================================
//  API ROUTES
// ============================================================

// GET /api/me
app.get("/api/me", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const ref = req.query.ref ? String(req.query.ref).replace("ref_", "") : null;
  const user = getOrCreateUser(userId, ref);
  applyPassiveIncome(user);
  regenEnergy(user);
  res.json(publicState(user));
});

// POST /api/tap
app.post("/api/tap", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const user = getOrCreateUser(userId);
  regenEnergy(user);

  const count = Math.max(1, Math.min(parseInt(req.body.count) || 1, 100));
  const affordable = Math.min(count, Math.floor(user.energy));

  if (affordable <= 0) {
    return res.status(400).json({ error: "no_energy", state: publicState(user) });
  }

  const earned = affordable * perTap(user);
  user.energy -= affordable;
  user.balance += earned;
  user.lifetimeEarned += earned;

  res.json({ state: publicState(user) });
});

// POST /api/upgrade
app.post("/api/upgrade", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const { key } = req.body;
  if (!UPGRADES[key]) return res.status(400).json({ error: "invalid_key" });

  const user = getOrCreateUser(userId);
  regenEnergy(user);

  const currentLevel = key === "multitap" ? user.multitapLevel : user.energyLimitLevel;
  const cost = upgradeCost(key, currentLevel);

  if (user.balance < cost) {
    return res.status(400).json({ error: "not_enough_coins", state: publicState(user) });
  }

  user.balance -= cost;
  if (key === "multitap") user.multitapLevel += 1;
  else user.energyLimitLevel += 1;

  res.json({ state: publicState(user) });
});

// GET /api/cards
app.get("/api/cards", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const user = getOrCreateUser(userId);
  applyPassiveIncome(user);

  const cards = CARDS.map((c) => {
    const level = user.cards[c.id] || 0;
    return {
      id: c.id, name: c.name, category: c.category,
      level, pphPerLevel: c.basePph,
      currentPph: c.basePph * level,
      nextCost: cardCost(c, level),
    };
  });

  res.json({ state: publicState(user), cards });
});

// POST /api/cards/buy
app.post("/api/cards/buy", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const { cardId } = req.body;
  const card = CARDS.find((c) => c.id === cardId);
  if (!card) return res.status(400).json({ error: "invalid_card" });

  const user = getOrCreateUser(userId);
  regenEnergy(user);

  const level = user.cards[cardId] || 0;
  const cost = cardCost(card, level);

  if (user.balance < cost) {
    return res.status(400).json({ error: "not_enough_coins" });
  }

  user.balance -= cost;
  user.cards[cardId] = level + 1;

  const cards = CARDS.map((c) => {
    const lv = user.cards[c.id] || 0;
    return {
      id: c.id, name: c.name, category: c.category,
      level: lv, pphPerLevel: c.basePph,
      currentPph: c.basePph * lv,
      nextCost: cardCost(c, lv),
    };
  });

  res.json({ state: publicState(user), cards });
});

// GET /api/tasks
app.get("/api/tasks", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const user = getOrCreateUser(userId);
  const tasks = TASKS.map((t) => ({
    ...t, completed: user.completedTasks.includes(t.id),
  }));

  res.json({ tasks });
});

// POST /api/tasks/complete
app.post("/api/tasks/complete", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const { taskId } = req.body;
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) return res.status(400).json({ error: "invalid_task" });

  const user = getOrCreateUser(userId);

  if (user.completedTasks.includes(taskId)) {
    return res.status(400).json({ error: "already_completed" });
  }

  user.completedTasks.push(taskId);
  user.balance += task.reward;
  user.lifetimeEarned += task.reward;

  const tasks = TASKS.map((t) => ({
    ...t, completed: user.completedTasks.includes(t.id),
  }));

  res.json({ state: publicState(user), tasks, reward: task.reward });
});

// POST /api/daily-cipher/claim
app.post("/api/daily-cipher/claim", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const user = getOrCreateUser(userId);
  const now = Date.now();

  if (now - user.lastDailyClaim < 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: "already_claimed" });
  }

  user.lastDailyClaim = now;
  user.balance += DAILY_REWARD;
  user.lifetimeEarned += DAILY_REWARD;

  res.json({ state: publicState(user), reward: DAILY_REWARD });
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok", message: "Red Panda Bot API running!" }));

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Red Panda backend running on port ${PORT}`));
