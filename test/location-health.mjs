import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'location-health-test-'));

const location = await import('../lib/location.js');
const health = await import('../lib/watch-health.js');
const petNest = await import('../lib/pet-nest.js');

const home = location.addLocationPlace({
  name: '家', latitude: -37.8136, longitude: 144.9631, radius_m: 250
});
assert.equal(home.name, '家');

let state = await location.updateLocation({
  latitude: -37.8137, longitude: 144.9632, accuracy_m: 18,
  speed: 0, locality: 'Melbourne', observed_at: '2026-10-08T00:00:00+11:00'
});
assert.equal(state.current.status, '在家');
assert.equal(state.current.place_id, home.id);

state = await location.updateLocation({
  latitude: -37.825, longitude: 144.975, accuracy_m: 25,
  speed: 8, locality: 'Melbourne', observed_at: '2026-10-08T00:15:00+11:00'
});
assert.equal(state.current.status, '在路上');
assert.equal(state.changed_place, true);

const approximate = location.getLocationState();
assert.equal(approximate.current.approximate, true);
assert.equal(approximate.current.latitude, -37.825);

const snapshot = health.normalizeWatchHealth({
  latest: { heartRate: { value: 82 }, bloodOxygen: 97 },
  activity: { stepCount: 6543 }, sleep_summary: { duration_minutes: 431 }
});
assert.equal(snapshot.heart_rate_bpm, 82);
assert.equal(snapshot.blood_oxygen_percent, 97);
assert.equal(snapshot.steps, 6543);
assert.equal(snapshot.sleep.duration_minutes, 431);

petNest.syncPetNest({
  food: 12,
  pets: [{ id: 'pet-1', name: '栗子', emoji: '🐿️', happiness: 88 }]
});
const household = await petNest.getPetHousehold();
assert.equal(household.food, 12);
assert.equal(household.pets[0].name, '栗子');
const care = await petNest.careForPet('pet-1', 'feed');
assert.equal(care.queued, true);
const pending = petNest.pendingPetActions();
assert.equal(pending.length, 1);
petNest.completePetAction(pending[0].id, { ok: true });
assert.equal(petNest.pendingPetActions().length, 0);

console.log('✓ 低功耗定位、常用地点、手表健康与宠物窝桥接');
