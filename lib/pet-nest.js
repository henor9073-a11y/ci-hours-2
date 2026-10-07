import fs from 'fs';
import os from 'os';
import path from 'path';
import { file, newId, now, readJSON, writeJSON } from './muwen/common.js';

const DEFAULT_CREDENTIALS = path.join(os.homedir(), '.local', 'share', 'cove-pet-nest', 'credentials.json');
const CACHE_FILE = file('pet-nest-cache.json');
const ACTIONS_FILE = file('pet-nest-actions.json');

function directURL() {
  // Render 访问不到 Mac mini 的 localhost。只有明确配置了可访问地址时才直连；
  // 默认由 Mac mini 上的窗口代理轮询、同步和执行照料动作。
  return String(process.env.PET_NEST_URL || '').replace(/\/$/, '');
}

function token() {
  if (process.env.PET_NEST_TOKEN) return process.env.PET_NEST_TOKEN;
  const credentialsPath = process.env.PET_NEST_CREDENTIALS || DEFAULT_CREDENTIALS;
  try {
    const value = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    return String(value.token || value.access_token || value.auth_token || value.api_key || '');
  } catch {
    return '';
  }
}

async function request(route, options = {}) {
  const base = directURL();
  if (!base) throw new Error('宠物窝需要等待 Mac mini 同步');
  const auth = token();
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (auth) {
    headers.Authorization = `Bearer ${auth}`;
    headers['x-access-token'] = auth;
  }
  const response = await fetch(base + route, { ...options, headers, signal: AbortSignal.timeout(5_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) throw new Error(`宠物窝连接失败（${response.status}）：${body.error || body.message || '未知错误'}`);
  return body;
}

function petView(value = {}) {
  const satiety = Number.isFinite(Number(value.satiety)) ? Number(value.satiety) : null;
  const kindEmoji = {
    cat: '🐈', dog: '🐕', parrot: '🦜', snow_leopard: '🐆',
    snake: '🐍', lizard: '🦎', egg: '🥚'
  };
  return {
    id: String(value.id || value.pet_id || value.uuid || ''),
    name: String(value.name || value.display_name || '小宠物'),
    species: String(value.species || value.type || value.kind || ''),
    emoji: String(value.emoji || value.icon || kindEmoji[value.kind] || '🐾'),
    mood: String(value.mood || value.status || ''),
    hunger: Number.isFinite(Number(value.hunger)) ? Number(value.hunger) : satiety === null ? null : Math.max(0, 100 - satiety),
    happiness: Number.isFinite(Number(value.happiness ?? value.affection ?? value.traits?.attachment)) ? Number(value.happiness ?? value.affection ?? value.traits?.attachment) : null,
    energy: Number.isFinite(Number(value.energy ?? value.traits?.energy)) ? Number(value.energy ?? value.traits?.energy) : null,
    last_cared_at: value.last_cared_at || value.lastCareAt || null
  };
}

function petList(value) {
  const candidates = Array.isArray(value) ? value
    : Array.isArray(value?.pets) ? value.pets
      : Array.isArray(value?.household?.pets) ? value.household.pets : [];
  return candidates.map(petView).filter(pet => pet.id);
}

function householdView(raw = {}) {
  const foodValue = raw.food ?? raw.food_amount ?? raw.grains ?? raw.supplies?.food ?? raw.household?.food;
  return {
    food: Number.isFinite(Number(foodValue)) ? Number(foodValue) : null,
    food_label: String(raw.food_label || raw.supplies?.food_label || ''),
    pets: petList(raw),
    synced_at: raw.synced_at || now()
  };
}

function cachedHousehold() {
  return readJSON(CACHE_FILE, null);
}

function actions() {
  const value = readJSON(ACTIONS_FILE, []);
  return Array.isArray(value) ? value : [];
}

function saveActions(value) {
  writeJSON(ACTIONS_FILE, value.slice(-200));
}

export async function getPetHousehold() {
  if (directURL()) return householdView(await request('/api/household'));
  return cachedHousehold() || {
    food: null,
    food_label: '等待 Mac mini 同步',
    pets: [],
    synced_at: null,
    stale: true
  };
}

export async function getPet(id) {
  if (directURL()) return petView(await request(`/api/pets/${encodeURIComponent(id)}`));
  const pet = cachedHousehold()?.pets?.find(item => item.id === id);
  if (!pet) throw new Error('小窝还没有同步这只宠物');
  return pet;
}

export async function careForPet(id, action) {
  const allowed = new Set(['feed', 'pet', 'play']);
  if (!allowed.has(action)) throw new Error('action 必须是 feed / pet / play');
  if (directURL()) {
    const raw = await request(`/api/pets/${encodeURIComponent(id)}/care`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action })
    });
    return { ok: true, action, pet: petView(raw.pet || raw), message: raw.message || null };
  }
  const pet = cachedHousehold()?.pets?.find(item => item.id === id);
  if (!pet) throw new Error('小窝还没有同步这只宠物');
  const item = {
    id: newId('petcare_'), pet_id: id, action, status: 'queued',
    requested_at: now(), completed_at: null, error: null
  };
  const value = actions();
  value.push(item);
  saveActions(value);
  return { ok: true, queued: true, action, pet, message: '已经送到小窝，Mac mini 会马上处理' };
}

// 以下三个入口只给 Mac mini 固定用途代理使用。
export function syncPetNest(payload = {}) {
  const raw = payload.household && typeof payload.household === 'object' ? payload.household : payload;
  const value = householdView(raw);
  writeJSON(CACHE_FILE, value);
  return value;
}

export function pendingPetActions(limit = 20) {
  return actions().filter(item => item.status === 'queued').slice(0, Math.max(1, Math.min(Number(limit) || 20, 50)));
}

export function completePetAction(id, result = {}) {
  const value = actions();
  const item = value.find(candidate => candidate.id === id);
  if (!item) throw new Error('找不到这次照料动作');
  item.status = result.ok === false ? 'failed' : 'completed';
  item.completed_at = now();
  item.error = result.error ? String(result.error) : null;
  saveActions(value);
  if (result.household && typeof result.household === 'object') syncPetNest(result.household);
  return item;
}
