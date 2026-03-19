'use strict';
/**
 * Standalone compatibility test for homebridge-garage-door-wsensor.
 * Run with:  node test.js
 *
 * No npm install required. child_process and homebridge are fully mocked.
 */

const Module = require('module');

// ─── Mock child_process (intercept before the plugin loads it) ────────────────
let mockSensorReading = 1; // raw GPIO value: 1 = closed (with pull-up, sensor open = HIGH)
let lastExecCmd = null;
let lastExecSyncCmd = null;

const mockChildProcess = {
    execSync(cmd, opts) {
        lastExecSyncCmd = cmd;
        if (cmd === 'gpiodetect') return Buffer.from('gpiochip0 [pinctrl-bcm2711] (58 lines)\n');
        if (cmd.startsWith('gpioget')) {
            // v2 syntax probe and reads: return active/inactive
            return Buffer.from(mockSensorReading ? 'active' : 'inactive');
        }
        return Buffer.from('');
    },
    exec(cmd, opts, cb) {
        lastExecCmd = cmd;
        const callback = typeof opts === 'function' ? opts : cb;
        if (callback) callback(null);
    },
};

const _originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'child_process') return mockChildProcess;
    return _originalLoad.apply(this, arguments);
};

// Load the plugin (child_process will be intercepted above)
const pluginFactory = require('./index.js');

// ─── Tiny test harness ────────────────────────────────────────────────────────
let passed = 0, failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗  ${name}`);
        console.error(`       ${err.message}`);
        failed++;
    }
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(`${msg || 'assertEqual'}: expected "${b}", got "${a}"`);
}
function assertTrue(v, msg) {
    if (!v) throw new Error(msg || `Expected truthy value, got "${v}"`);
}
function assertInstanceOf(v, T, msg) {
    if (!(v instanceof T)) throw new Error(msg || `Expected instanceof ${T.name}`);
}

// ─── Mock HAP characteristic ──────────────────────────────────────────────────
function makeCharacteristic(supportsHB2) {
    const c = {
        _getHandlers: [],
        _setHandlers: [],
        _onGetFn: null,
        _onSetFn: null,
        _updatedValue: undefined,

        updateValue(v) { this._updatedValue = v; return this; },

        on(event, fn) {
            if (event === 'get') this._getHandlers.push(fn);
            if (event === 'set') this._setHandlers.push(fn);
            return this;
        },

        // Helpers used by tests to invoke the registered handlers
        callGet() {
            return new Promise((res, rej) => {
                if (this._onGetFn)
                    Promise.resolve(this._onGetFn()).then(res).catch(rej);
                else if (this._getHandlers.length)
                    this._getHandlers[0]((e, v) => (e ? rej(e) : res(v)));
                else
                    rej(new Error('No get handler registered'));
            });
        },
        callSet(v) {
            return new Promise((res, rej) => {
                if (this._onSetFn)
                    Promise.resolve(this._onSetFn(v)).then(res).catch(rej);
                else if (this._setHandlers.length)
                    this._setHandlers[0](v, (e) => (e ? rej(e) : res()));
                else
                    rej(new Error('No set handler registered'));
            });
        },
    };

    // Only expose onGet/onSet in HB2 mode
    if (supportsHB2) {
        c.onGet = function (fn) { this._onGetFn = fn; return this; };
        c.onSet = function (fn) { this._onSetFn = fn; return this; };
    }

    return c;
}

// ─── Mock HAP Service + Homebridge object ─────────────────────────────────────
function makeHomebridgeMock(supportsHB2) {
    // Each call creates fresh references so closures are consistent
    const TargetDoorState  = { CLOSED: 0, OPEN: 1 };
    const CurrentDoorState = { CLOSED: 0, OPEN: 1 };

    const targetChar  = makeCharacteristic(supportsHB2);
    const currentChar = makeCharacteristic(supportsHB2);

    class ServiceMock {
        constructor(name) { this.name = name; }
        setCharacteristic()  { return this; }
        getCharacteristic(c) {
            if (c === TargetDoorState)  return targetChar;
            if (c === CurrentDoorState) return currentChar;
            return makeCharacteristic(supportsHB2);
        }
    }

    let AccessoryCtor;
    const hb = {
        hap: {
            Service: { GarageDoorOpener: ServiceMock },
            Characteristic: { TargetDoorState, CurrentDoorState },
        },
        registerAccessory(_plugin, _name, Ctor) { AccessoryCtor = Ctor; },
    };

    // This sets the module-level Service/Characteristic vars inside index.js
    pluginFactory(hb);

    return { AccessoryCtor, targetChar, currentChar };
}

// ─── Test config ──────────────────────────────────────────────────────────────
const BASE_CONFIG = { name: 'Test Garage', doorRelayPin: 11, doorSensorPin: 13, duration_ms: 0 };
const mockLog = Object.assign(() => {}, { warn: () => {}, error: () => {} });

// ─────────────────────────────────────────────────────────────────────────────
async function runTests() {

    // ── Homebridge 2.0 (onGet / onSet) ──────────────────────────────────────
    console.log('\n── Homebridge 2.0  (promise-based  onGet / onSet) ──────────────────');

    const { AccessoryCtor: Ctor2, targetChar: tc2, currentChar: cc2 } = makeHomebridgeMock(true);
    const acc2 = new Ctor2(mockLog, BASE_CONFIG);
    acc2.getServices();

    await test('onGet registered on CurrentDoorState', () =>
        assertTrue(cc2._onGetFn !== null, 'onGet not registered on CurrentDoorState'));

    await test('onGet registered on TargetDoorState', () =>
        assertTrue(tc2._onGetFn !== null, 'onGet not registered on TargetDoorState'));

    await test('onSet registered on TargetDoorState', () =>
        assertTrue(tc2._onSetFn !== null, 'onSet not registered on TargetDoorState'));

    await test('Legacy on("get") NOT used for CurrentDoorState in HB2 mode', () =>
        assertEqual(cc2._getHandlers.length, 0,
            'on("get") handler count should be 0 in HB2 mode'));

    await test('Legacy on("set") NOT used for TargetDoorState in HB2 mode', () =>
        assertEqual(tc2._setHandlers.length, 0,
            'on("set") handler count should be 0 in HB2 mode'));

    await test('getSensorStatusAsync returns a Promise', () => {
        const result = acc2.getSensorStatusAsync();
        assertInstanceOf(result, Promise, 'getSensorStatusAsync must return a Promise');
        return result;
    });

    await test('onGet (CurrentDoor) resolves to a number (0 or 1)', async () => {
        mockSensorReading = 1;
        const val = await cc2.callGet();
        assertTrue(val === 0 || val === 1, `Expected 0 or 1, got ${val}`);
    });

    await test('setDoorStateAsync returns a Promise', () => {
        mockSensorReading = 0; // sensor open, so state differs from requested close
        const result = acc2.setDoorStateAsync(1);
        assertInstanceOf(result, Promise, 'setDoorStateAsync must return a Promise');
        return result;
    });

    await test('onSet (TargetDoor) resolves without error', async () => {
        mockSensorReading = 0;
        await tc2.callSet(1);
    });

    // ── Homebridge 1.x (callback-based on("get") / on("set")) ───────────────
    console.log('\n── Homebridge 1.x  (callback-based  on("get") / on("set")) ─────────');

    const { AccessoryCtor: Ctor1, targetChar: tc1, currentChar: cc1 } = makeHomebridgeMock(false);
    const acc1 = new Ctor1(mockLog, BASE_CONFIG);
    acc1.getServices();

    await test('on("get") registered on CurrentDoorState', () =>
        assertEqual(cc1._getHandlers.length, 1,
            'on("get") handler not registered on CurrentDoorState'));

    await test('on("get") registered on TargetDoorState', () =>
        assertEqual(tc1._getHandlers.length, 1,
            'on("get") handler not registered on TargetDoorState'));

    await test('on("set") registered on TargetDoorState', () =>
        assertEqual(tc1._setHandlers.length, 1,
            'on("set") handler not registered on TargetDoorState'));

    await test('onGet NOT used in HB1 mode', () =>
        assertTrue(cc1._onGetFn === null, 'onGet should be null in HB1 mode'));

    await test('onSet NOT used in HB1 mode', () =>
        assertTrue(tc1._onSetFn === null, 'onSet should be null in HB1 mode'));

    await test('on("get") (CurrentDoor) calls back with a number (0 or 1)', async () => {
        mockSensorReading = 1;
        const val = await cc1.callGet();
        assertTrue(val === 0 || val === 1, `Expected 0 or 1, got ${val}`);
    });

    await test('on("set") (TargetDoor) calls back without error', async () => {
        mockSensorReading = 0;
        await tc1.callSet(1);
    });

    // ── Common error handling ────────────────────────────────────────────────
    console.log('\n── Error handling ───────────────────────────────────────────────────');

    await test('throws if doorRelayPin is missing', () => {
        const { AccessoryCtor } = makeHomebridgeMock(true);
        try {
            new AccessoryCtor(mockLog, { name: 'X', doorSensorPin: 13, duration_ms: 0 });
            throw new Error('Should have thrown');
        } catch (e) {
            assertTrue(e.message.includes('doorRelayPin'), `Wrong error: ${e.message}`);
        }
    });

    await test('throws if doorSensorPin is missing', () => {
        const { AccessoryCtor } = makeHomebridgeMock(true);
        try {
            new AccessoryCtor(mockLog, { name: 'X', doorRelayPin: 11, duration_ms: 0 });
            throw new Error('Should have thrown');
        } catch (e) {
            assertTrue(e.message.includes('doorSensorPin'), `Wrong error: ${e.message}`);
        }
    });

    await test('throws if duration_ms is not an integer', () => {
        const { AccessoryCtor } = makeHomebridgeMock(true);
        try {
            new AccessoryCtor(mockLog,
                { name: 'X', doorRelayPin: 11, doorSensorPin: 13, duration_ms: 1.5 });
            throw new Error('Should have thrown');
        } catch (e) {
            assertTrue(e.message.includes('duration'), `Wrong error: ${e.message}`);
        }
    });

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(53)}`);
    console.log(`  ${passed} passed   ${failed} failed`);
    console.log('');
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('\nUnexpected test runner error:', err);
    process.exit(1);
});
