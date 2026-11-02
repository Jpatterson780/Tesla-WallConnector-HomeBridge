# homebridge-tesla-wall-connector-local

Homebridge plugin that monitors a **Tesla Wall Connector (Gen 3)** in HomeKit using the charger's local, unauthenticated status API (`http://<charger-ip>/api/1/vitals`). No Tesla account or cloud access is needed.

The local API is read-only, so this plugin **monitors** the charger; it cannot start or stop charging.

## What shows up in HomeKit

Each Wall Connector becomes one accessory made up of sensors:

| Service | Meaning | Source field |
|---|---|---|
| **Occupancy Sensor** "Charging" (main tile) | Occupied = charging | `contactor_closed` |
| **Contact Sensor** "Vehicle Connected" | Contact detected = plugged in | `vehicle_connected` |
| **Temperature Sensor** "Handle Temperature" | Charge handle temperature | `handle_temp_c` |
| Temperature Sensor "PCBA Temperature" *(off by default)* | Internal board temperature | `pcba_temp_c` |
| Temperature Sensor "MCU Temperature" *(off by default)* | Microcontroller temperature | `mcu_temp_c` |
| Outlet *(off by default)* | **On** = actively charging; **In Use** = vehicle plugged in. Becomes the main tile when turned on | `contactor_closed`, `vehicle_connected` |
| ↳ Eve power metering | Voltage (V), Current (A), Power (W), Total energy (kWh, lifetime) | `grid_v`, `vehicle_current_a`, computed, `/api/1/lifetime` `energy_wh` |

#### Power and energy readings need the outlet

HomeKit has no service type for power or energy, so the only place to put those readings is on an outlet, where the Eve app knows to look for them. Turn on `showOutlet` if you want them. The outlet can't actually be switched: the charger's local API is read-only.

Notes:

- Apple's Home app doesn't display the Eve power/energy values, even with the outlet turned on. Use the Eve, Controller for HomeKit, or Home+ app to see them and build automations on them.
- The contact and occupancy sensors let you trigger Home app automations, for example "notify me when the car is plugged in" or "when charging stops".
- If you toggle the outlet in HomeKit, the plugin logs that the API is read-only and switches it back.
- If the charger reports any `current_alerts`, the sensors show **Status Fault** and the alerts are logged.
- If the charger can't be reached, its tiles show **No Response** until it comes back.
- Serial number, part number, and firmware are read from `/api/1/version`.

### Power calculation

Power is reported as 0 W whenever the contactor is open, which filters out idle sensor noise. While charging:

- **Single/split phase** (e.g. North America, 240 V): `vehicle_current_a × grid_v`
- **Three phase**, detected when phase C has voltage and current: the sum of `current{A,B,C}_a × voltage{A,B,C}_v`

## Installation

Search for **homebridge-tesla-wall-connector-local** on the Plugins tab of the Homebridge UI and install it. Or install it from the command line:

```bash
sudo npm install -g homebridge-tesla-wall-connector-local
```

Give the charger a DHCP reservation or static IP so its address doesn't change. You can confirm the API works with `curl http://<charger-ip>/api/1/vitals`.

## Configuration

Use the Homebridge UI settings screen, or add this to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "TeslaWallConnectorLocal",
      "name": "Tesla Wall Connector",
      "chargers": [
        {
          "name": "Garage Charger",
          "host": "192.168.1.50",
          "pollInterval": 15,
          "timeout": 5,
          "showOutlet": false,
          "showVehicleConnectedSensor": true,
          "showChargingSensor": true,
          "showHandleTemperature": true,
          "showPcbaTemperature": false,
          "showMcuTemperature": false
        }
      ]
    }
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `name` | `Wall Connector` | Accessory name |
| `host` | *required* | IP address or hostname. A port, or an `http://` prefix, is allowed |
| `pollInterval` | `15` | Seconds between polls (minimum 5) |
| `timeout` | `5` | HTTP request timeout, in seconds |
| `showOutlet` | `false` | Also show the charger as an outlet, which adds power and energy readings in the Eve app |
| `show*` (other) | see above | Turns each sensor on or off. Turning one off removes it from HomeKit |

You can list several chargers. Each one is identified by its `host`, so if you change a charger's IP, HomeKit treats it as a new accessory.

## Development

```bash
npm install
npm run build      # compile to dist/
npm run watch      # recompile on change
```

Set Homebridge to debug mode (`-D`) to log a summary line on every poll: EVSE state, current, voltage, power, session energy, and handle temperature.
