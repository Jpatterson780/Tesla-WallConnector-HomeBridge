import type { Categories, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import { chargingCurrentA, computePowerW, WallConnectorClient, type Lifetime, type Vitals } from './client';
import type { TeslaWallConnectorPlatform } from './platform';
import {
  DEFAULT_POLL_INTERVAL_S,
  DEFAULT_TIMEOUT_S,
  MIN_POLL_INTERVAL_S,
  type ChargerConfig,
} from './settings';

type TempKey = 'handle_temp_c' | 'pcba_temp_c' | 'mcu_temp_c';

/** Returns the cached or newly registered accessory for one role of a charger. */
export type AccessoryProvider = (role: string, displayName: string, category: Categories) => PlatformAccessory;

interface Tile {
  label: string;
  accessory: PlatformAccessory;
  service: Service;
}

/**
 * One Wall Connector, exposed as a separate HomeKit accessory per tile so the Home app shows each
 * as its own tile instead of grouping them (and picking an arbitrary one to represent the group):
 *  - "<name> Charging": Occupancy Sensor, detected while charging.
 *  - "<name> Vehicle Connected": Occupancy Sensor, detected while a vehicle is plugged in.
 *  - "<name>" (optional): Outlet. On = charging, Outlet In Use = plugged in, plus Eve power
 *    metering (V / A / W / lifetime kWh). The local API is read-only, so toggles are reverted.
 *  - Optional temperature sensors for handle / PCBA / MCU (off by default: HomeKit counts every
 *    temperature sensor in the room's climate summary).
 *
 * All tiles share one poller.
 */
export class WallConnector {
  private readonly client: WallConnectorClient;
  private readonly pollIntervalMs: number;

  private readonly outlet?: Tile;
  private readonly chargingSensor?: Tile;
  private readonly vehicleSensor?: Tile;
  private readonly tempSensors: (Tile & { key: TempKey })[] = [];

  private vitals?: Vitals;
  private lifetime?: Lifetime;
  private online = false;
  private haveVersion = false;
  private lastAlerts = '[]';
  private failures = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly platform: TeslaWallConnectorPlatform,
    private readonly config: ChargerConfig,
    provide: AccessoryProvider,
  ) {
    const { Service, Characteristic } = platform;
    const { Categories } = platform.api.hap;
    const name = config.name || 'Wall Connector';

    this.client = new WallConnectorClient(config.host, (config.timeout ?? DEFAULT_TIMEOUT_S) * 1000);
    this.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_S, config.pollInterval ?? DEFAULT_POLL_INTERVAL_S) * 1000;

    const tile = (role: string, label: string, displayName: string, category: Categories, type: WithUUID<typeof Service>): Tile => {
      const accessory = provide(role, displayName, category);
      accessory.getService(Service.AccessoryInformation)!
        .setCharacteristic(Characteristic.Manufacturer, 'Tesla')
        .setCharacteristic(Characteristic.Model, 'Wall Connector')
        .setCharacteristic(Characteristic.SerialNumber, config.host);
      return { label, accessory, service: this.ensureService(accessory, type, displayName, role) };
    };

    // Charging
    if (config.showChargingSensor ?? true) {
      this.chargingSensor = tile('charging', 'Charging', `${name} Charging`, Categories.SENSOR, Service.OccupancySensor);
      this.chargingSensor.service.getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => this.read(v => this.occupancy(!!v.contactor_closed)));
      this.chargingSensor.service.getCharacteristic(Characteristic.StatusFault);
    }

    // Vehicle connected
    if (config.showVehicleConnectedSensor ?? true) {
      this.vehicleSensor = tile('vehicle', 'Vehicle Connected', `${name} Vehicle Connected`, Categories.SENSOR, Service.OccupancySensor);
      this.vehicleSensor.service.getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => this.read(v => this.occupancy(!!v.vehicle_connected)));
      this.vehicleSensor.service.getCharacteristic(Characteristic.StatusFault);
    }

    // Outlet (the only place Eve power metering can live)
    if (config.showOutlet ?? false) {
      this.outlet = tile('outlet', 'Outlet', name, Categories.OUTLET, Service.Outlet);
      const outlet = this.outlet.service;
      outlet.getCharacteristic(Characteristic.On)
        .onGet(() => this.read(v => !!v.contactor_closed))
        .onSet(value => this.rejectSet(value));
      outlet.getCharacteristic(Characteristic.OutletInUse)
        .onGet(() => this.read(v => !!v.vehicle_connected));

      const eve = platform.Eve;
      for (const c of [eve.Voltage, eve.ElectricCurrent, eve.CurrentConsumption, eve.TotalConsumption]) {
        outlet.addOptionalCharacteristic(c);
      }
      outlet.getCharacteristic(eve.Voltage).onGet(() => this.read(v => round(v.grid_v ?? 0, 1)));
      outlet.getCharacteristic(eve.ElectricCurrent).onGet(() => this.read(v => round(chargingCurrentA(v), 1)));
      outlet.getCharacteristic(eve.CurrentConsumption).onGet(() => this.read(v => Math.round(computePowerW(v))));
      outlet.getCharacteristic(eve.TotalConsumption).onGet(() => this.read(() => this.totalKWh()));
    }

    // Temperatures
    const tempDefs: { role: string; label: string; key: TempKey; enabled: boolean }[] = [
      { role: 'handle-temp', label: 'Handle Temperature', key: 'handle_temp_c', enabled: config.showHandleTemperature ?? false },
      { role: 'pcba-temp', label: 'PCBA Temperature', key: 'pcba_temp_c', enabled: config.showPcbaTemperature ?? false },
      { role: 'mcu-temp', label: 'MCU Temperature', key: 'mcu_temp_c', enabled: config.showMcuTemperature ?? false },
    ];
    for (const def of tempDefs.filter(d => d.enabled)) {
      const t = tile(def.role, def.label, `${name} ${def.label}`, Categories.SENSOR, Service.TemperatureSensor);
      t.service.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -50, maxValue: 150, minStep: 0.1 })
        .onGet(() => this.read(v => round(v[def.key] ?? 0, 1)));
      t.service.getCharacteristic(Characteristic.StatusFault);
      this.tempSensors.push({ ...t, key: def.key });
    }

    const shown = this.tiles().map(t => t.label);
    if (shown.length === 0) {
      platform.log.warn(`[${name}] Every tile is turned off in the config, so nothing will show in HomeKit.`);
    } else {
      platform.log.info(`[${name}] Showing in HomeKit: ${shown.join(', ')}`);
    }

    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  // ---------------------------------------------------------------- polling

  private async poll(): Promise<void> {
    try {
      this.vitals = await this.client.getVitals();
      if (!this.haveVersion) {
        await this.updateVersion();
      }
      // Lifetime stats are a nice-to-have; don't mark the charger offline if only this fails.
      this.lifetime = await this.client.getLifetime().catch(() => this.lifetime);

      if (!this.online) {
        this.platform.log.info(`[${this.config.name}] Connected to Wall Connector at ${this.config.host}.`);
      }
      this.online = true;
      this.failures = 0;
      this.checkAlerts(this.vitals);
      this.pushUpdates();
    } catch (err) {
      this.failures++;
      const msg = err instanceof Error ? err.message : String(err);
      if (this.online || this.failures === 1) {
        this.platform.log.warn(`[${this.config.name}] Unable to reach Wall Connector at ${this.config.host}: ${msg}`);
      } else {
        this.platform.log.debug(`[${this.config.name}] Poll failed (${this.failures}): ${msg}`);
      }
      this.online = false;
      this.pushFaults();
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.poll(), this.pollIntervalMs);
      }
    }
  }

  private async updateVersion(): Promise<void> {
    const { Service, Characteristic } = this.platform;
    try {
      const version = await this.client.getVersion();
      const fw = version.firmware_version?.match(/^\d+(\.\d+){0,2}/)?.[0];
      for (const { accessory } of this.tiles()) {
        const info = accessory.getService(Service.AccessoryInformation)!;
        if (version.serial_number) {
          info.updateCharacteristic(Characteristic.SerialNumber, version.serial_number);
        }
        if (version.part_number) {
          info.updateCharacteristic(Characteristic.Model, `Wall Connector (${version.part_number})`);
        }
        if (fw) {
          info.updateCharacteristic(Characteristic.FirmwareRevision, fw);
        }
      }
      this.haveVersion = true;
      this.platform.log.info(
        `[${this.config.name}] Wall Connector ${version.part_number ?? ''} S/N ${version.serial_number ?? '?'} firmware ${version.firmware_version ?? '?'}`,
      );
    } catch (err) {
      // Version is only cosmetic; vitals polling will report reachability problems.
      this.platform.log.debug(`[${this.config.name}] Could not read /api/1/version: ${err instanceof Error ? err.message : err}`);
    }
  }

  private checkAlerts(v: Vitals): void {
    const alerts = JSON.stringify(v.current_alerts ?? []);
    if (alerts !== this.lastAlerts) {
      if ((v.current_alerts?.length ?? 0) > 0) {
        this.platform.log.warn(`[${this.config.name}] Wall Connector alerts: ${alerts}`);
      } else {
        this.platform.log.info(`[${this.config.name}] Wall Connector alerts cleared.`);
      }
      this.lastAlerts = alerts;
    }
  }

  private pushUpdates(): void {
    const v = this.vitals!;
    const { Characteristic } = this.platform;
    const eve = this.platform.Eve;
    const fault = (v.current_alerts?.length ?? 0) > 0
      ? Characteristic.StatusFault.GENERAL_FAULT
      : Characteristic.StatusFault.NO_FAULT;

    this.outlet?.service
      .updateCharacteristic(Characteristic.On, !!v.contactor_closed)
      .updateCharacteristic(Characteristic.OutletInUse, !!v.vehicle_connected)
      .updateCharacteristic(eve.Voltage, round(v.grid_v ?? 0, 1))
      .updateCharacteristic(eve.ElectricCurrent, round(chargingCurrentA(v), 1))
      .updateCharacteristic(eve.CurrentConsumption, Math.round(computePowerW(v)))
      .updateCharacteristic(eve.TotalConsumption, this.totalKWh());

    this.chargingSensor?.service
      .updateCharacteristic(Characteristic.OccupancyDetected, this.occupancy(!!v.contactor_closed))
      .updateCharacteristic(Characteristic.StatusFault, fault);

    this.vehicleSensor?.service
      .updateCharacteristic(Characteristic.OccupancyDetected, this.occupancy(!!v.vehicle_connected))
      .updateCharacteristic(Characteristic.StatusFault, fault);

    for (const { key, service } of this.tempSensors) {
      service
        .updateCharacteristic(Characteristic.CurrentTemperature, round(v[key] ?? 0, 1))
        .updateCharacteristic(Characteristic.StatusFault, fault);
    }

    this.platform.log.debug(
      `[${this.config.name}] state=${v.evse_state} connected=${v.vehicle_connected} charging=${v.contactor_closed} `
      + `${round(chargingCurrentA(v), 1)}A ${round(v.grid_v ?? 0, 1)}V ${Math.round(computePowerW(v))}W `
      + `session=${round((v.session_energy_wh ?? 0) / 1000, 2)}kWh handle=${v.handle_temp_c}°C`,
    );
  }

  private pushFaults(): void {
    const { Characteristic } = this.platform;
    for (const t of [this.chargingSensor, this.vehicleSensor, ...this.tempSensors]) {
      t?.service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }
  }

  // ---------------------------------------------------------------- helpers

  private tiles(): Tile[] {
    return [this.chargingSensor, this.vehicleSensor, this.outlet, ...this.tempSensors].filter((t): t is Tile => !!t);
  }

  /** Serve a value from the latest poll, or report "No Response" while the charger is unreachable. */
  private read<T extends CharacteristicValue>(fn: (v: Vitals) => T): T {
    if (!this.online || !this.vitals) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return fn(this.vitals);
  }

  private rejectSet(value: CharacteristicValue): void {
    const charging = !!this.vitals?.contactor_closed;
    if (value !== charging) {
      this.platform.log.info(`[${this.config.name}] The Wall Connector local API is read-only; charging cannot be switched from HomeKit.`);
      setTimeout(() => this.outlet?.service.updateCharacteristic(this.platform.Characteristic.On, charging), 250);
    }
  }

  private occupancy(detected: boolean): number {
    const { OccupancyDetected } = this.platform.Characteristic;
    return detected ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private totalKWh(): number {
    return round((this.lifetime?.energy_wh ?? 0) / 1000, 3);
  }

  private ensureService(accessory: PlatformAccessory, type: WithUUID<typeof Service>, name: string, subtype: string): Service {
    const { Characteristic } = this.platform;
    const existing = accessory.getServiceById(type, subtype);
    if (existing) {
      return existing;
    }
    const service = accessory.addService(type, name, subtype);
    service.setCharacteristic(Characteristic.Name, name);
    // Lets iOS 16+ show our label; only set on creation so renames in the Home app stick.
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, name);
    return service;
  }
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
