# homebridge-garage-door-wsensor

A [Homebridge](https://homebridge.io) plugin for controlling a garage door opener via a Raspberry Pi GPIO relay, with optional door state sensor support.

Compatible with **Homebridge 1.x** and **Homebridge 2.0**.

---

## Requirements

- Raspberry Pi (any model with GPIO)
- Node.js >= 14.15.3
- Homebridge >= 1.1.7 (including 2.0)
- A relay module wired to a GPIO output pin
- (Optional) A magnetic reed sensor or similar wired to a GPIO input pin

---

## Installation

### Option 1: Homebridge UI (recommended)

Search for `homebridge-garage-door-wsensor` in the Homebridge UI plugin tab and click **Install**.

### Option 2: Command line

```bash
npm install -g homebridge-garage-door-wsensor
```

Or, to install from a local copy of this repository:

```bash
cd /path/to/this/folder
npm install
npm link
```

---

## Homebridge Configuration

Add the following to the `accessories` section of your Homebridge `config.json`:

```json
{
    "accessory": "Garage Door Opener",
    "name": "Garage Door",
    "doorRelayPin": 8,
    "doorSensorPin": 23,
    "duration_ms": 500,
    "invertDoorState": false,
    "invertSensorState": false,
    "input_pull": "up"
}
```

> **Note:** `doorRelayPin` and `doorSensorPin` must be **BCM GPIO numbers** (not physical board pin numbers). See the [GPIO Pin Map](#gpio-pin-map-physical-board-vs-bcm-pigpio) section below.

### Configuration Options

| Option             | Type    | Required | Default | Description |
|--------------------|---------|----------|---------|-------------|
| `name`             | string  | Yes      | —       | Name of the accessory as it appears in HomeKit |
| `doorRelayPin`     | integer | Yes      | —       | **BCM** GPIO number connected to the relay (see pin map below) |
| `doorSensorPin`    | integer | Yes      | —       | **BCM** GPIO number connected to the door sensor (see pin map below) |
| `duration_ms`      | integer | No       | `0`     | How long (in milliseconds) to hold the relay closed. Set to `0` to hold indefinitely |
| `invertDoorState`  | boolean | No       | `false` | Invert the relay output logic (HIGH/LOW) for the door |
| `invertSensorState`| boolean | No       | `false` | Invert the sensor reading logic |
| `input_pull`       | string  | No       | `"none"`| Internal pull resistor for sensor pin: `"up"`, `"down"`, or `"none"` |

---

## Wiring

### Relay (door trigger)
- Connect the relay signal wire to the GPIO pin specified by `doorRelayPin`.
- Connect relay COM/NO terminals in parallel with the garage door button.

### Door Sensor (optional but recommended)
- Connect one leg of the sensor to the GPIO pin specified by `doorSensorPin`.
- Connect the other leg to ground (if using `input_pull: "up"`) or to 3.3V (if using `input_pull: "down"`).

> **Important:** This plugin uses **pigpio**, which requires **BCM GPIO numbers** — NOT physical board pin numbers. Use the table below to find the correct value for your config.

### Migrating from rpio (old plugin version)?

If you were previously using this plugin with `rpio`, your config used **physical board pin numbers**. You must convert them to BCM numbers:

| Old rpio config value (physical pin) | New pigpio config value (BCM) |
|:---:|:---:|
| 11 | 17 |
| 12 | 18 |
| 13 | 27 |
| 15 | 22 |
| 16 | 23 |
| 18 | 24 |
| 19 | 10 |
| 21 | 9 |
| 22 | 25 |
| 23 | 11 |
| 24 | 8 |
| 26 | 7 |

For any pin not listed, use the full GPIO Pin Map below.

---

## GPIO Pin Map: Physical Board vs BCM (pigpio)

The Raspberry Pi header has 40 physical pins. Only the GPIO pins are usable — use the **BCM** column in your `config.json`.

```
Physical  BCM  |  Physical  BCM
Pin   1   3.3V |  Pin   2   5V
Pin   3     2  |  Pin   4   5V
Pin   5     3  |  Pin   6   GND
Pin   7     4  |  Pin   8   14
Pin   9   GND  |  Pin  10   15
Pin  11    17  |  Pin  12   18
Pin  13    27  |  Pin  14   GND
Pin  15    22  |  Pin  16   23
Pin  17   3.3V |  Pin  18   24
Pin  19    10  |  Pin  20   GND
Pin  21     9  |  Pin  22   25
Pin  23    11  |  Pin  24    8
Pin  25   GND  |  Pin  26    7
Pin  27     0  |  Pin  28    1
Pin  29     5  |  Pin  30   GND
Pin  31     6  |  Pin  32   12
Pin  33    13  |  Pin  34   GND
Pin  35    19  |  Pin  36   16
Pin  37    26  |  Pin  38   20
Pin  39   GND  |  Pin  40   21
```

**Common examples:**

| Physical Pin | BCM GPIO | Use in config |
|:---:|:---:|:---|
| 11 | 17 | `"doorRelayPin": 17` |
| 13 | 27 | `"doorSensorPin": 27` |
| 15 | 22 | `"doorRelayPin": 22` |
| 16 | 23 | `"doorSensorPin": 23` |
| 18 | 24 | `"doorRelayPin": 24` |
| 22 | 25 | `"doorSensorPin": 25` |

> **Tip:** You can also run `pinout` on the Raspberry Pi terminal for a live visual diagram of your board.

---

## Running Homebridge

Start Homebridge normally — the plugin will be loaded automatically:

```bash
homebridge
```

Or with the service manager (if configured as a service):

```bash
sudo systemctl start homebridge
```

To view logs:

```bash
sudo journalctl -fu homebridge
```

---

## Troubleshooting

- **"You must provide a config value for 'doorRelayPin'"** — Ensure `doorRelayPin` is set in your `config.json`.
- **"You must provide a config value for 'doorSensorPin'"** — Ensure `doorSensorPin` is set in your `config.json`.
- **Relay fires but door doesn't move** — Check your wiring and try toggling `invertDoorState`.
- **Sensor always shows wrong state** — Try toggling `invertSensorState` or changing `input_pull`.
- **Permission denied on GPIO** — Run Homebridge as root or ensure the user is in the `gpio` group: `sudo usermod -aG gpio $USER`

---

## License

ISC

## Author

skirkpatrick88
