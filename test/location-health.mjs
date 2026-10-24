import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'location-health-test-'));

const location = await import('../lib/location.js');
const health = await import('../lib/watch-health.js');
const watchCloud = await import('../lib/watch-cloud.js');
const petNest = await import('../lib/pet-nest.js');

const home = location.addLocationPlace({
  name: '家', latitude: -37.8136, longitude: 144.9631, radius_m: 100
});
assert.equal(home.name, '家');

let state = await location.updateLocation({
  latitude: -37.8137, longitude: 144.9632, accuracy_m: 18,
  speed: 0, locality: 'Melbourne', observed_at: '2026-10-08T00:00:00+11:00'
});
assert.equal(state.current.status, '在家');
assert.equal(state.current.place_id, home.id);

state = await location.updateLocation({
  latitude: -37.8125, longitude: 144.9631, accuracy_m: 22,
  speed: 0, locality: 'Melbourne', observed_at: '2026-10-08T00:02:00+11:00'
});
assert.equal(state.current.status, '在家');
assert.equal(state.current.place_id, home.id);
assert.equal(state.changed_place, false);

state = await location.updateLocation({
  latitude: -37.825, longitude: 144.975, accuracy_m: 1_414,
  speed: 0, locality: 'Docklands', observed_at: '2026-10-08T00:04:00+11:00'
});
assert.equal(state.ignored, 'poor_accuracy');
assert.equal(state.current.place_id, home.id);

state = await location.updateLocation({
  latitude: -37.825, longitude: 144.975, accuracy_m: 25,
  speed: 8, locality: 'Melbourne', observed_at: '2026-10-08T00:03:00+11:00'
});
assert.equal(state.ignored, 'stale_or_duplicate');
assert.equal(state.current.place_id, home.id);

state = await location.updateLocation({
  latitude: -37.825, longitude: 144.975, accuracy_m: 25,
  speed: 8, locality: 'Melbourne', observed_at: '2026-10-08T00:15:00+11:00'
});
assert.equal(state.current.status, '在家');
assert.equal(state.changed_place, false);
assert.equal(state.transition_pending.count, 1);

state = await location.updateLocation({
  latitude: -37.8251, longitude: 144.9751, accuracy_m: 24,
  speed: 8, locality: 'Melbourne', observed_at: '2026-10-08T00:16:00+11:00'
});
assert.equal(state.current.status, '在路上');
assert.equal(state.changed_place, true);

const approximate = location.getLocationState();
assert.equal(approximate.current.approximate, true);
assert.equal(approximate.current.latitude, -37.825);

const snapshot = health.normalizeWatchHealth({
  latest: { heartRate: { value: 82 }, bloodOxygen: 97, hrv: 48 },
  activity: { stepCount: 6543, activeEnergy: 312 }, sleep_summary: { duration_minutes: 431 }
});
assert.equal(snapshot.heart_rate_bpm, 82);
assert.equal(snapshot.blood_oxygen_percent, 97);
assert.equal(snapshot.steps, 6543);
assert.equal(snapshot.hrv_ms, 48);
assert.equal(snapshot.active_energy_kcal, 312);
assert.equal(snapshot.sleep.duration_minutes, 431);
const disconnected = health.normalizeWatchHealth({ heartRate: null, bloodOxygen: null, steps: null, sleep: null });
assert.equal(disconnected.heart_rate_bpm, null);
assert.equal(disconnected.blood_oxygen_percent, null);
assert.equal(disconnected.steps, null);

const phoneUsage = await import('../lib/phone-usage.js');
const usage = phoneUsage.ingestPhoneUsage({
  date: '2026-10-18', total_seconds: 7_200, pickups: 18,
  apps: [{ name: '木屋', bundle_id: 'com.nor.cy', duration_seconds: 1_800, pickups: 4 }]
});
assert.equal(usage.total_seconds, 7_200);
assert.equal(phoneUsage.getPhoneUsage('2026-10-18').apps[0].name, '木屋');

const vibration = watchCloud.enqueueWatchCommand({
  id: 'relay-vibration-1', type: 'vibrate', pattern: 'heartbeat', message: '在'
});
assert.equal(vibration.id, 'relay-vibration-1');
assert.equal(watchCloud.enqueueWatchCommand({ id: 'relay-vibration-1', type: 'vibrate' }).created_at, vibration.created_at);
assert.equal(watchCloud.nextWatchCommand('').id, 'relay-vibration-1');
const voice = watchCloud.enqueueWatchCommand({ id: 'relay-voice-1', type: 'voice', transcript: '我在这里' });
assert.equal(watchCloud.nextWatchCommand('relay-vibration-1').id, voice.id);
assert.equal(watchCloud.nextWatchCommand(voice.id), null);
assert.equal(watchCloud.watchEventReceipt('watch-event-1'), null);
watchCloud.recordWatchEventReceipt('watch-event-1', 'message-1');
assert.equal(watchCloud.watchEventReceipt('watch-event-1').message_id, 'message-1');

petNest.syncPetNest({
  grains: 12,
  pets: [{ id: 'pet-1', name: '栗子', kind: 'cat', satiety: 72, traits: { attachment: 88, energy: 65 } }]
});
const household = await petNest.getPetHousehold();
assert.equal(household.food, 12);
assert.equal(household.pets[0].name, '栗子');
assert.equal(household.pets[0].hunger, 28);
assert.equal(household.pets[0].happiness, 88);
const care = await petNest.careForPet('pet-1', 'feed');
assert.equal(care.queued, true);
const pending = petNest.pendingPetActions();
assert.equal(pending.length, 1);
petNest.completePetAction(pending[0].id, { ok: true });
assert.equal(petNest.pendingPetActions().length, 0);

console.log('✓ 低功耗定位、常用地点、手表健康与宠物窝桥接');
