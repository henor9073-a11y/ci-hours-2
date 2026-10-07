import { file, readJSON, writeJSON, newId, now } from './muwen/common.js';
import { sendSystemEvent } from './muwen/chat.js';

const FILE = file('location-state.json');
const DEFAULT_RADIUS_METERS = 220;

function blank() {
  return { version: 1, current: null, places: [] };
}

function load() {
  const value = readJSON(FILE, blank());
  return {
    version: 1,
    current: value && typeof value.current === 'object' ? value.current : null,
    places: Array.isArray(value?.places) ? value.places : []
  };
}

function save(value) {
  writeJSON(FILE, value);
  return value;
}

function finite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} 必须是数字`);
  return number;
}

function coordinate(input = {}) {
  const latitude = finite(input.latitude, 'latitude');
  const longitude = finite(input.longitude, 'longitude');
  if (latitude < -90 || latitude > 90) throw new Error('latitude 超出范围');
  if (longitude < -180 || longitude > 180) throw new Error('longitude 超出范围');
  return { latitude, longitude };
}

function haversineMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const earth = 6_371_000;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function classify(state, point) {
  let nearest = null;
  for (const place of state.places) {
    const distance = haversineMeters(point, place);
    if (!nearest || distance < nearest.distance_m) nearest = { place, distance_m: distance };
  }
  if (nearest && nearest.distance_m <= nearest.place.radius_m) {
    return {
      kind: 'place', place_id: nearest.place.id, place_name: nearest.place.name,
      status: `在${nearest.place.name}`, distance_m: Math.round(nearest.distance_m)
    };
  }
  const locality = String(point.locality || point.area || '').trim().slice(0, 80);
  const moving = Number(point.speed) >= 1.5;
  return {
    kind: moving ? 'moving' : 'nearby', place_id: null, place_name: null,
    status: moving ? '在路上' : locality ? `在${locality}附近` : '位置已更新',
    distance_m: nearest ? Math.round(nearest.distance_m) : null
  };
}

function publicCurrent(current, exact = false) {
  if (!current) return null;
  const value = { ...current };
  if (!exact) {
    value.latitude = Math.round(Number(value.latitude) * 1000) / 1000;
    value.longitude = Math.round(Number(value.longitude) * 1000) / 1000;
    value.approximate = true;
  }
  return value;
}

export function getLocationState({ exact = false } = {}) {
  const state = load();
  return { version: state.version, current: publicCurrent(state.current, exact), places: state.places };
}

export async function updateLocation(input = {}) {
  const state = load();
  const previous = state.current;
  const coords = coordinate(input);
  const point = {
    ...coords,
    accuracy_m: Math.max(0, Number(input.accuracy_m) || 0),
    speed: Number.isFinite(Number(input.speed)) ? Number(input.speed) : -1,
    locality: String(input.locality || '').trim().slice(0, 80),
    area: String(input.area || '').trim().slice(0, 80),
    source_device: String(input.source_device || 'sigh_ios').slice(0, 80),
    observed_at: String(input.observed_at || now()),
    updated_at: now()
  };
  state.current = { ...point, ...classify(state, point) };
  save(state);

  const oldPlace = previous?.place_id || null;
  const newPlace = state.current.place_id || null;
  if (previous && oldPlace !== newPlace) {
    if (oldPlace && previous.place_name) {
      await sendSystemEvent(`棋子离开了${previous.place_name}`, 'location_leave');
    }
    if (newPlace && state.current.place_name) {
      await sendSystemEvent(`棋子到了${state.current.place_name}`, 'location_arrive');
    }
  }
  return { ...getLocationState(), changed_place: oldPlace !== newPlace };
}

export function addLocationPlace(input = {}) {
  const state = load();
  const coords = coordinate(input);
  const name = String(input.name || '').trim().slice(0, 40);
  if (!name) throw new Error('地点名称不能为空');
  const place = {
    id: newId('lp_'), name, ...coords,
    radius_m: Math.max(80, Math.min(2_000, Number(input.radius_m) || DEFAULT_RADIUS_METERS)),
    created_at: now(), updated_at: now()
  };
  state.places.push(place);
  if (state.current) state.current = { ...state.current, ...classify(state, state.current) };
  save(state);
  return place;
}

export function updateLocationPlace(id, patch = {}) {
  const state = load();
  const place = state.places.find(item => item.id === id);
  if (!place) return null;
  if (patch.name !== undefined) {
    const name = String(patch.name).trim().slice(0, 40);
    if (!name) throw new Error('地点名称不能为空');
    place.name = name;
  }
  if (patch.latitude !== undefined || patch.longitude !== undefined) {
    Object.assign(place, coordinate({ latitude: patch.latitude ?? place.latitude, longitude: patch.longitude ?? place.longitude }));
  }
  if (patch.radius_m !== undefined) place.radius_m = Math.max(80, Math.min(2_000, Number(patch.radius_m) || DEFAULT_RADIUS_METERS));
  place.updated_at = now();
  if (state.current) state.current = { ...state.current, ...classify(state, state.current) };
  save(state);
  return place;
}

export function removeLocationPlace(id) {
  const state = load();
  const before = state.places.length;
  state.places = state.places.filter(item => item.id !== id);
  if (state.places.length === before) return null;
  if (state.current) state.current = { ...state.current, ...classify(state, state.current) };
  save(state);
  return { ok: true, id };
}
