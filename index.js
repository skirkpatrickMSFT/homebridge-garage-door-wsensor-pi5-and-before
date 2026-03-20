var Service, Characteristic, TargetDoorState, CurrentDoorState;
const { execSync, exec } = require('child_process');

// Auto-detect the GPIO chip that represents the 40-pin header.
// Pi 4 -> gpiochip0 [pinctrl-bcm2711], Pi 5 -> gpiochip4 [pinctrl-rp1]
function detectGpioChip(log) {
    try {
        var output = execSync('gpiodetect', { timeout: 2000 }).toString();
        var lines = output.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].includes('pinctrl')) {
                var m = lines[i].match(/^(gpiochip\d+)/);
                if (m) return m[1];
            }
        }
        var first = lines[0] && lines[0].match(/^(gpiochip\d+)/);
        return first ? first[1] : 'gpiochip0';
    } catch (e) {
        if (log) log.warn('gpiodetect failed, defaulting to gpiochip0: ' + e.message.split('\n')[0]);
        return 'gpiochip0';
    }
}

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    TargetDoorState = Characteristic.TargetDoorState;
    CurrentDoorState = Characteristic.CurrentDoorState;
    DoorState = homebridge.hap.Characteristic.CurrentDoorState;
    homebridge.registerAccessory('homebridge-garage-door-wsensor', 'Garage Door Opener', GarageDoorOpener);
}

// NOTE: doorRelayPin and doorSensorPin must be BCM GPIO numbers (not physical board pin numbers)
// Requires: sudo apt install gpiod  (provides gpioget/gpioset - works on Pi 5)
function GarageDoorOpener(log, config) {
    this.log = log;
    this.name = config.name;
    this.doorRelayPin = config.doorRelayPin;
    this.doorSensorPin = config.doorSensorPin;
    this.currentDoorState = 0;
    this.targetDoorState = 0;
    this.invertDoorState = defaultVal(config["invertDoorState"], false);
    this.invertSensorState = defaultVal(config['invertSensorState'], false);
    this.default = defaultVal(config["default_state"], false);
    this.duration = defaultVal(config["duration_ms"], 200);
    this.pullConfig = defaultVal(config["input_pull"], "none");
    this.gpiochip = defaultVal(config["gpiochip"], null); // null = auto-detect
    // legacyGpiod: set true only on Pi 4 / older systems with gpiod v1
    // Pi 5 / Bookworm always has gpiod v2 (default)
    this.legacyGpiod = defaultVal(config["legacyGpiod"], false);
    this.doorState = 0;       // current physical state from sensor
    this.targetState = 0;     // desired state from HomeKit commands
    this.sensorChange = 0;
    this.service = null;

    if (!this.doorRelayPin) throw new Error("You must provide a config value for 'doorRelayPin'.");
    if (!this.doorSensorPin) throw new Error("You must provide a config value for 'doorSensorPin'.");
    if (!is_int(this.duration)) throw new Error("The config value 'duration' must be an integer number of milliseconds.");

    if (!this.gpiochip) {
        this.gpiochip = detectGpioChip(this.log);
        this.log("Auto-detected GPIO chip: %s", this.gpiochip);
    }

    this.log("gpiod syntax: %s  chip: %s  sensor cmd: %s",
        this.legacyGpiod ? 'v1 (legacy)' : 'v2 (default)',
        this.gpiochip,
        this.legacyGpiod
            ? `gpioget ${this.gpiochip} ${this.doorSensorPin}`
            : `gpioget -c ${this.gpiochip} ${this.doorSensorPin}`
    );

    this.log("Creating a garage door relay named '%s', initial state: %s", this.name, (this.invertDoorState ? "OPEN" : "CLOSED"));

    // Configure sensor pull resistor via pinctrl (Raspberry Pi, works on Pi 5)
    if (this.pullConfig !== 'none') {
        try {
            const pullFlag = this.pullConfig === 'up' ? 'pu' : 'pd';
            execSync(`pinctrl set ${this.doorSensorPin} ip ${pullFlag}`, { stdio: 'pipe' });
        } catch (e) {
            this.log.warn('Could not configure pull resistor via pinctrl (install rpi-utils if needed): ' + e.message.split('\n')[0]);
        }
    }

    this.checkSensor(e => {});

    // Sync targetState with physical state at startup so HomeKit sees no
    // mismatch on first poll and doesn't immediately send an onSet command
    this.targetState = this.readSensorState();
    this.doorState = this.targetState;
    this.sensorChange = this.targetState;
    this.log("Initial door state: %s", this.targetState === 0 ? 'CLOSED' : 'OPEN');
}

GarageDoorOpener.prototype.getServices = function () {
    var initialState = this.targetState;
    this.service = new Service.GarageDoorOpener(this.name, this.name);
    this.service.setCharacteristic(TargetDoorState, initialState);
    this.service.setCharacteristic(CurrentDoorState, initialState);

    var currentDoorChar = this.service.getCharacteristic(CurrentDoorState);
    var targetDoorChar = this.service.getCharacteristic(TargetDoorState);

    // Homebridge 2.0 uses onGet/onSet (promise-based); 1.x uses on('get')/on('set') (callback-based)
    if (typeof currentDoorChar.onGet === 'function') {
        // Homebridge 2.0 style
        // CurrentDoorState: reads physical sensor
        // TargetDoorState: returns stored target (NOT sensor) to prevent HomeKit
        //   re-sending setTarget when sensor state changes
        currentDoorChar
            .onGet(this.getSensorStatusAsync.bind(this));
        targetDoorChar
            .onGet(() => Promise.resolve(this.targetState))
            .onSet(this.setDoorStateAsync.bind(this));
    } else {
        // Homebridge 1.x style
        currentDoorChar
            .on('get', this.getSensorStatus.bind(this));
        targetDoorChar
            .on('get', (cb) => cb(null, this.targetState))
            .on('set', this.setDoorState.bind(this));
    }

    return [this.service];
}

// Homebridge 1.x: callback-based get handler
GarageDoorOpener.prototype.getSensorStatus = function (callback) {
    callback(null, this.readSensorState());
}

// Homebridge 2.0: promise-based get handler
GarageDoorOpener.prototype.getSensorStatusAsync = function () {
    return Promise.resolve(this.readSensorState());
}

GarageDoorOpener.prototype.checkSensor = function (callback) {
    setTimeout(() => {
        this.doorState = this.readSensorState();
        if (this.service && this.doorState !== this.sensorChange) {
            // Only update CurrentDoorState - updating TargetDoorState triggers the onSet
            // handler which would fire the relay
            this.service.getCharacteristic(CurrentDoorState).updateValue(this.doorState);
            this.sensorChange = this.doorState;
        }
        this.checkSensor(callback);
    }, 500);

    callback(null);
}

GarageDoorOpener.prototype.readSensorState = function () {
    try {
        var cmd = this.legacyGpiod
            ? `gpioget ${this.gpiochip} ${this.doorSensorPin}`
            : `gpioget -c ${this.gpiochip} ${this.doorSensorPin}`;
        var output = execSync(cmd, { timeout: 1000 }).toString().trim();
        // v2 outputs '"23"=active' or '"23"=inactive'; v1 outputs '0' or '1'
        var raw;
        if (output.includes('inactive')) raw = 0;
        else if (output.includes('active')) raw = 1;
        else raw = parseInt(output, 10) ? 1 : 0;
        var val = this.gpioSensorVal(raw);
        return val === 1 ? 1 : 0;
    } catch (e) {
        this.log.error('gpioget sensor error: ' + e.message.split('\n')[0]);
        return this.doorState;
    }
}

// Pulse relay using 'timeout' to hold the line for duration_ms then release.
// 'timeout Ns gpioset -c chip pin=0' blocks gpioset for N seconds then kills
// it, which releases the GPIO line. Works reliably with all gpiod v2 builds.
// v1 fallback uses -m time -u <microseconds>.
GarageDoorOpener.prototype.setState = function (activate) {
    if (!activate) return;
    var ms = this.duration > 0 ? this.duration : 200;
    var seconds = (ms / 1000).toFixed(3);
    var chip = this.gpiochip;
    var pin = this.doorRelayPin;

    if (this.legacyGpiod) {
        exec(`gpioset -m time -u ${ms * 1000} ${chip} ${pin}=0`, { timeout: ms + 5000 }, (err) => {
            if (err) this.log.error('Relay error: ' + err.message.split('\n')[0]);
        });
        return;
    }

    // Pi 5 / gpiod v2: pin holds its last value after process exits.
    // Step 1 — drive LOW (relay ON) for duration; exec callback fires when timeout kills gpioset.
    // Step 2 — 100ms later (enough for kernel to release the line), drive HIGH (relay OFF).
    //           timeout 2 holds the HIGH so pin stays HIGH even after that gpioset is killed.
    this.log("Relay pulse: pin=%s LOW for %dms", pin, ms);
    exec(`timeout ${seconds} gpioset -c ${chip} ${pin}=0`, { timeout: ms + 2000 }, () => {
        setTimeout(() => {
            this.log("Relay release: pin=%s HIGH", pin);
            exec(`timeout 2 gpioset -c ${chip} ${pin}=1`, { timeout: 5000 }, (err) => {
                if (err && err.code !== 124) this.log.error('Relay OFF error: ' + err.message.split('\n')[0]);
            });
        }, 100);
    });
}

// Homebridge 1.x: callback-based set handler
GarageDoorOpener.prototype.setDoorState = function (newState, callback) {
    this.targetState = newState;
    this.log("Relay triggered: target=%s current=%s", newState, this.readSensorState());
    this.setState(1);
    callback(null);
}

// Homebridge 2.0: promise-based set handler
GarageDoorOpener.prototype.setDoorStateAsync = function (newState) {
    this.targetState = newState;
    this.log("Relay triggered: target=%s current=%s", newState, this.readSensorState());
    this.setState(1);
    return Promise.resolve();
}

GarageDoorOpener.prototype.gpioSensorVal = function (val) {
    if (this.invertSensorState) val = !val;
    return val ? 1 : 0;
}

GarageDoorOpener.prototype.gpioDoorVal = function (val) {
    if (this.invertDoorState) val = !val;
    return val ? 0 : 1; // active-LOW relay: 0=trigger, 1=release
}

var is_int = function (n) {
    return n % 1 === 0;
}

var is_defined = function (v) {
    return typeof v !== 'undefined';
}

var defaultVal = function (v, dflt) {
    return is_defined(v) ? v : dflt;
}
