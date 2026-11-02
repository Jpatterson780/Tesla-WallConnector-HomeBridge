import type { CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import { chargingCurrentA, computePowerW, WallConnectorClient, type Lifetime, type Vitals } from './client';
import type { TeslaWallConnectorPlatform } from './platform';
import {
  DEFAULT_POLL_INTERVAL_S,
  DEFAULT_TIMEOUT_S,
  MIN_POLL_INTERVAL_S,
  type ChargerConfig,
} from './settings';

type TempKey = 'handle_temp_c' | 'pcba_temp_c' | 'mcu_temp_c';

interface TempSensorDef {
  subtype: string;
  label: string;
  key: TempKey;
  enabled: boolean;
}

/**
 * One HomeKit accessory per Wall Connector:
 *  - Occupancy Sensor "Charging" (occupied = charging), primary by default.
 *  - Contact Sensor "Vehicle Connected" (contact detected = plugged in).
 *  - Optional Outlet: On = charging (contactor closed), Outlet In Use = vehicle plugged in,
 *    plus Eve power metering (V / A / W / lifetime kWh). Primary when enabled.
 *  - Optional Temperature Sensors for handle / PCBA / MCU.
 *
 * The local API is read-only, so attempts to toggle the outlet are reverted.
 */
export class WallConnectorAccessory {
  private readonly client: WallConnectorClient;
  private readonly pollIntervalMs: number;

  private readonly outlet?: Service;
  private readonly vehicleSensor?: Service;
  private readonly chargingSensor?: Service;
  private readonly tempSensors: { def: TempSensorDef; service: Service }[] = [];

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
    private readonly accessory: PlatformAccessory,
    private readonly config: ChargerConfig,
  ) {
    const { Service, Characteristic } = platform;

    this.client = new WallConnectorClient(config.host, (config.timeout ?? DEFAULT_TIMEOUT_S) * 1000);
    this.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_S, config.pollInterval ?? DEFAULT_POLL_INTERVAL_S) * 1000;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Tesla')
      .setCharacteristic(Characteristic.Model, 'Wall Connector')
      .setCharacteristic(Characteristic.SerialNumber, config.host);

    // Outlet (the only place Eve power metering can live)
    if (config.showOutlet ?? false) {
      const outlet = this.ensureService(Service.Outlet, config.name, 'outlet');
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
      this.outlet = outlet;
    } else {
      this.removeService(Service.Outlet, 'outlet');
    }

    // Vehicle connected
    if (config.showVehicleConnectedSensor ?? true) {
      this.vehicleSensor = this.ensureService(Service.ContactSensor, 'Vehicle Connected', 'vehicle');
      this.vehicleSensor.getCharacteristic(Characteristic.ContactSensorState)
        .onGet(() => this.read(v => this.contactState(v)));
      this.vehicleSensor.getCharacteristic(Characteristic.StatusFault);
    } else {
      this.removeService(Service.ContactSensor, 'vehicle');
    }

    // Charging
    if (config.showChargingSensor ?? true) {
      this.chargingSensor = this.ensureService(Service.OccupancySensor, 'Charging', 'charging');
      this.chargingSensor.getCharacteristic(Characteristic.OccupancyDetected)
        .onGet(() => this.read(v => this.occupancyState(v)));
      this.chargingSensor.getCharacteristic(Characteristic.StatusFault);
    } else {
      this.removeService(Service.OccupancySensor, 'charging');
    }

    // Temperatures
    const tempDefs: TempSensorDef[] = [
      { subtype: 'handle-temp', label: 'Handle Temperature', key: 'handle_temp_c', enabled: config.showHandleTemperature ?? true },
      { subtype: 'pcba-temp', label: 'PCBA Temperature', key: 'pcba_temp_c', enabled: config.showPcbaTemperature ?? false },
      { subtype: 'mcu-temp', label: 'MCU Temperature', key: 'mcu_temp_c', enabled: config.showMcuTemperature ?? false },
    ];
    for (const def of tempDefs) {
      if (!def.enabled) {
        this.removeService(Service.TemperatureSensor, def.subtype);
        continue;
      }
      const service = this.ensureService(Service.TemperatureSensor, def.label, def.subtype);
      service.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: -50, maxValue: 150, minStep: 0.1 })
        .onGet(() => this.read(v => round(v[def.key] ?? 0, 1)));
      service.getCharacteristic(Characteristic.StatusFault);
      this.tempSensors.push({ def, service });
    }

    // The primary service decides which tile/icon the Home app shows for the accessory.
    const primary = this.outlet ?? this.chargingSensor ?? this.vehicleSensor ?? this.tempSensors[0]?.service;
    for (const service of [this.outlet, this.chargingSensor, this.vehicleSensor, ...this.tempSensors.map(t => t.service)]) {
      service?.setPrimaryService(service === primary);
    }
    if (!primary) {
      platform.log.warn(`[${config.name}] Every service is turned off in the config, so nothing will show in HomeKit.`);
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
      const info = this.accessory.getService(Service.AccessoryInformation)!;
      if (version.serial_number) {
        info.updateCharacteristic(Characteristic.SerialNumber, version.serial_number);
      }
      if (version.part_number) {
        info.updateCharacteristic(Characteristic.Model, `Wall Connector (${version.part_number})`);
      }
      const fw = version.firmware_version?.match(/^\d+(\.\d+){0,2}/)?.[0];
      if (fw) {
        info.updateCharacteristic(Characteristic.FirmwareRevision, fw);
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

    this.outlet
      ?.updateCharacteristic(Characteristic.On, !!v.contactor_closed)
      .updateCharacteristic(Characteristic.OutletInUse, !!v.vehicle_connected)
      .updateCharacteristic(eve.Voltage, round(v.grid_v ?? 0, 1))
      .updateCharacteristic(eve.ElectricCurrent, round(chargingCurrentA(v), 1))
      .updateCharacteristic(eve.CurrentConsumption, Math.round(computePowerW(v)))
      .updateCharacteristic(eve.TotalConsumption, this.totalKWh());

    this.vehicleSensor
      ?.updateCharacteristic(Characteristic.ContactSensorState, this.contactState(v))
      .updateCharacteristic(Characteristic.StatusFault, fault);

    this.chargingSensor
      ?.updateCharacteristic(Characteristic.OccupancyDetected, this.occupancyState(v))
      .updateCharacteristic(Characteristic.StatusFault, fault);

    for (const { def, service } of this.tempSensors) {
      service
        .updateCharacteristic(Characteristic.CurrentTemperature, round(v[def.key] ?? 0, 1))
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
    const services = [this.vehicleSensor, this.chargingSensor, ...this.tempSensors.map(t => t.service)];
    for (const service of services) {
      service?.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    }
  }

  // ---------------------------------------------------------------- helpers

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
      setTimeout(() => this.outlet?.updateCharacteristic(this.platform.Characteristic.On, charging), 250);
    }
  }

  private contactState(v: Vitals): number {
    const { ContactSensorState } = this.platform.Characteristic;
    return v.vehicle_connected ? ContactSensorState.CONTACT_DETECTED : ContactSensorState.CONTACT_NOT_DETECTED;
  }

  private occupancyState(v: Vitals): number {
    const { OccupancyDetected } = this.platform.Characteristic;
    return v.contactor_closed ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  private totalKWh(): number {
    return round((this.lifetime?.energy_wh ?? 0) / 1000, 3);
  }

  private ensureService(type: WithUUID<typeof Service>, name: string, subtype: string): Service {
    const { Characteristic } = this.platform;
    const existing = this.accessory.getServiceById(type, subtype);
    if (existing) {
      return existing;
    }
    const service = this.accessory.addService(type, name, subtype);
    service.setCharacteristic(Characteristic.Name, name);
    // Lets iOS 16+ show our label instead of the accessory name; only set on creation so user renames stick.
    service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    service.setCharacteristic(Characteristic.ConfiguredName, name);
    return service;
  }

  private removeService(type: WithUUID<typeof Service>, subtype: string): void {
    const existing = this.accessory.getServiceById(type, subtype);
    if (existing) {
      this.accessory.removeService(existing);
    }
  }
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
