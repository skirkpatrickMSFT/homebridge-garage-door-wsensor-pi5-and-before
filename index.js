var Service, Characteristic, TargetDoorState, CurrentDoorState;
const { Gpio } = require('pigpio');

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    TargetDoorState = Characteristic.TargetDoorState;
    CurrentDoorState = Characteristic.CurrentDoorState;
    DoorState = homebridge.hap.Characteristic.CurrentDoorState;
    homebridge.registerAccessory('homebridge-garage-door-wsensor', 'Garage Door Opener', GarageDoorOpener);
}

// NOTE: doorRelayPin and doorSensorPin must be BCM GPIO numbers (not physical board pin numbers)
function GarageDoorOpener(log, config) {
    this.log = log;
    this.name = config.name;
    this.doorRelayPin = config.doorRelayPin;
    this.doorSensorPin = config.doorSensorPin;
    this.currentDoorState = CurrentDoorState.CLOSED;
    this.targetDoorState = TargetDoorState.CLOSED;
    this.invertDoorState = defaultVal(config["invertDoorState"], false);
    this.invertSensorState = defaultVal(config['invertSensorState'], false);
    this.default = defaultVal(config["default_state"], false);
    this.duration = defaultVal(config["duration_ms"], 0);
    this.pullConfig = defaultVal(config["input_pull"], "none");
    this.doorState = 0;
    this.sensorChange = 0;
    this.service = null;
    this.timerid = -1;

    if (!this.doorRelayPin) throw new Error("You must provide a config value for 'doorRelayPin'.");
    if (!this.doorSensorPin) throw new Error("You must provide a config value for 'doorSensorPin'.");
    if (!is_int(this.duration)) throw new Error("The config value 'duration' must be an integer number of milliseconds.");

    this.log("Creating a garage door relay named '%s', initial state: %s", this.name, (this.invertDoorState ? "OPEN" : "CLOSED"));

    this.relayGpio = new Gpio(this.doorRelayPin, { mode: Gpio.OUTPUT });
    this.relayGpio.digitalWrite(this.gpioDoorVal(this.invertDoorState));

    this.sensorGpio = new Gpio(this.doorSensorPin, {
        mode: Gpio.INPUT,
        pullUpDown: this.translatePullConfig(this.pullConfig)
    });

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
    setTimeout(e => {
        this.doorState = this.readSensorState();
        if (this.doorState !== this.sensorChange) {
            this.service.getCharacteristic(TargetDoorState).updateValue(this.doorState);
            this.service.getCharacteristic(CurrentDoorState).updateValue(this.doorState);
            this.sensorChange = this.doorState;
        }
        this.checkSensor(callback);
    }, 500);

    callback(null);
}

GarageDoorOpener.prototype.readSensorState = function () {
    var raw = this.sensorGpio.digitalRead();
    var val = this.gpioSensorVal(raw);
    return val === 1 ? 1 : 0; // closed / opened
}

GarageDoorOpener.prototype.setState = function (val) {
    this.relayGpio.digitalWrite(this.gpioDoorVal(val));
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

    if (this.timerid !== -1) {
        clearTimeout(this.timerid);
        this.timerid = -1;
    }

    this.setState(1);

    if (this.duration > 0) {
        this.timerid = setTimeout(this.timeOutCB, this.duration, this);
    }

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

    if (this.timerid !== -1) {
        clearTimeout(this.timerid);
        this.timerid = -1;
    }

    this.setState(1);

    if (this.duration > 0) {
        this.timerid = setTimeout(this.timeOutCB, this.duration, this);
    }

    return Promise.resolve();
}

GarageDoorOpener.prototype.timeOutCB = function (o) {
    o.setState(0);
    o.timerid = -1;
}

GarageDoorOpener.prototype.gpioSensorVal = function (val) {
    if (this.invertSensorState) val = !val;
    return val ? 1 : 0;
}

GarageDoorOpener.prototype.gpioDoorVal = function (val) {
    if (this.invertDoorState) val = !val;
    return val ? 0 : 1; // reversed logic
}

GarageDoorOpener.prototype.translatePullConfig = function (val) {
    if (val == "up") return Gpio.PUD_UP;
    else if (val == "down") return Gpio.PUD_DOWN;
    else return Gpio.PUD_OFF;
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
