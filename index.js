var Service, Characteristic, TargetDoorState, CurrentDoorState;
const { execSync, exec } = require('child_process');

// Detect gpiod major version (v1 vs v2 have incompatible CLI syntax)
// v1: gpioget <chip> <pin>       v2: gpioget -c <chip> <pin>
// v1: gpioset -m time -u <us>    v2: gpioset -t <ms>ms -c <chip>
function detectGpiodVersion() {
    // Some builds exit non-zero even for --version; check stdout/stderr either way
    function parseVersion(str) {
        var m = str && str.match(/v?(\d+)\./);
        return m ? parseInt(m[1], 10) : null;
    }
    var flags = ['--version', '-v', '-h', '--help'];
    for (var i = 0; i < flags.length; i++) {
        try {
            var out = execSync('gpioget ' + flags[i] + ' 2>&1', { timeout: 2000 }).toString();
            var v = parseVersion(out);
            if (v) return v;
        } catch (e) {
            // execSync throws on non-zero exit - version text may still be in output
            var combined = [e.stdout, e.stderr].map(b => b ? b.toString() : '').join('');
            var v = parseVersion(combined);
            if (v) return v;
        }
    }
    return 1; // safe default
}

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
        // Fallback: return the first chip listed
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
    this.duration = defaultVal(config["duration_ms"], 500);
    this.pullConfig = defaultVal(config["input_pull"], "none");
    this.gpiochip = defaultVal(config["gpiochip"], null); // null = auto-detect
    this.doorState = 0;
    this.sensorChange = 0;
    this.service = null;

    if (!this.doorRelayPin) throw new Error("You must provide a config value for 'doorRelayPin'.");
    if (!this.doorSensorPin) throw new Error("You must provide a config value for 'doorSensorPin'.");
    if (!is_int(this.duration)) throw new Error("The config value 'duration' must be an integer number of milliseconds.");

    if (!this.gpiochip) {
        this.gpiochip = detectGpioChip(this.log);
        this.log("Auto-detected GPIO chip: %s", this.gpiochip);
    }

    this.gpiodV2 = detectGpiodVersion() >= 2;
    this.log("gpiod version: %s  chip: %s  sensor cmd: %s",
        this.gpiodV2 ? 'v2+' : 'v1',
        this.gpiochip,
        this.gpiodV2
            ? `gpioget -c ${this.gpiochip} ${this.doorSensorPin}`
            : `gpioget ${this.gpiochip} ${this.doorSensorPin}`
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
}

GarageDoorOpener.prototype.getServices = function () {
    this.service = new Service.GarageDoorOpener(this.name, this.name);
    this.service.setCharacteristic(TargetDoorState, TargetDoorState.CLOSED);
    this.service.setCharacteristic(CurrentDoorState, CurrentDoorState.CLOSED);

    var currentDoorChar = this.service.getCharacteristic(CurrentDoorState);
    var targetDoorChar = this.service.getCharacteristic(TargetDoorState);

    // Homebridge 2.0 uses onGet/onSet (promise-based); 1.x uses on('get')/on('set') (callback-based)
    if (typeof currentDoorChar.onGet === 'function') {
        // Homebridge 2.0 style
        currentDoorChar
            .onGet(this.getSensorStatusAsync.bind(this));
        targetDoorChar
            .onGet(this.getSensorStatusAsync.bind(this))
            .onSet(this.setDoorStateAsync.bind(this));
    } else {
        // Homebridge 1.x style
        currentDoorChar
            .on('get', this.getSensorStatus.bind(this));
        targetDoorChar
            .on('get', this.getSensorStatus.bind(this))
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
            this.service.getCharacteristic(TargetDoorState).updateValue(this.doorState);
            this.service.getCharacteristic(CurrentDoorState).updateValue(this.doorState);
            this.sensorChange = this.doorState;
        }
        this.checkSensor(callback);
    }, 500);

    callback(null);
}

GarageDoorOpener.prototype.readSensorState = function () {
    try {
        var cmd = this.gpiodV2
            ? `gpioget -c ${this.gpiochip} ${this.doorSensorPin}`
            : `gpioget ${this.gpiochip} ${this.doorSensorPin}`;
        var output = execSync(cmd, { timeout: 1000 }).toString().trim();
        // gpiod v2 outputs "active"/"inactive"; v1 outputs "0"/"1"
        var raw;
        if (output === 'active')   raw = 1;
        else if (output === 'inactive') raw = 0;
        else raw = parseInt(output, 10) || 0;
        var val = this.gpioSensorVal(raw);
        return val === 1 ? 1 : 0;
    } catch (e) {
        this.log.error('gpioget sensor error: ' + e.message.split('\n')[0]);
        return this.doorState;
    }
}

// Pulse the relay for duration_ms then release (async, non-blocking)
GarageDoorOpener.prototype.setState = function (activate) {
    if (!activate) return;
    var gpioVal = this.gpioDoorVal(1);
    var ms = this.duration > 0 ? this.duration : 500;
    // v2: gpioset -t <ms>ms -c <chip> <pin>=<val>
    // v1: gpioset -m time -u <us> <chip> <pin>=<val>
    var cmd = this.gpiodV2
        ? `gpioset -t ${ms}ms -c ${this.gpiochip} ${this.doorRelayPin}=${gpioVal}`
        : `gpioset -m time -u ${ms * 1000} ${this.gpiochip} ${this.doorRelayPin}=${gpioVal}`;
    exec(cmd, { timeout: ms + 5000 }, (err) => {
        if (err && !err.killed) this.log.error('gpioset relay error: ' + err.message.split('\n')[0]);
    });
}

// Homebridge 1.x: callback-based set handler
GarageDoorOpener.prototype.setDoorState = function (newState, callback) {
    var nowState = this.readSensorState();
    this.log("Requesting new state %s, current state %s", newState, nowState);
    if (newState == nowState) {
        this.log("Already in requested state, doing nothing.");
        callback(null);
        return;
    }
    this.setState(1);
    callback(null);
}

// Homebridge 2.0: promise-based set handler
GarageDoorOpener.prototype.setDoorStateAsync = function (newState) {
    var nowState = this.readSensorState();
    this.log("Requesting new state %s, current state %s", newState, nowState);
    if (newState == nowState) {
        this.log("Already in requested state, doing nothing.");
        return Promise.resolve();
    }
    this.setState(1);
    return Promise.resolve();
}

GarageDoorOpener.prototype.gpioSensorVal = function (val) {
    if (this.invertSensorState) val = !val;
    return val ? 1 : 0;
}

GarageDoorOpener.prototype.gpioDoorVal = function (val) {
    if (this.invertDoorState) val = !val;
    return val ? 0 : 1; // reversed logic
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
