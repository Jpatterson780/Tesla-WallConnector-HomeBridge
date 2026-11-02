import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { WallConnector, type AccessoryProvider } from './accessory';
import { createEveCharacteristics, type EveCharacteristics } from './eve';
import { PLATFORM_NAME, PLUGIN_NAME, type ChargerConfig } from './settings';

export class TeslaWallConnectorPlatform implements DynamicPlatformPlugin {
  public readonly Service: API['hap']['Service'];
  public readonly Characteristic: API['hap']['Characteristic'];
  public readonly Eve: EveCharacteristics;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly handlers: WallConnector[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.Eve = createEveCharacteristics(api);

    this.api.on('didFinishLaunching', () => this.discoverDevices());
    this.api.on('shutdown', () => this.handlers.forEach(h => h.stop()));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private discoverDevices(): void {
    const chargers = (Array.isArray(this.config.chargers) ? this.config.chargers : []) as ChargerConfig[];
    const activeUuids = new Set<string>();
    const seenHosts = new Set<string>();

    chargers.forEach((charger, index) => {
      if (!charger?.host?.trim()) {
        // Easy to hit: each "Add Wall Connector" click adds a card with its own toggles.
        this.log.warn(
          `Wall Connector #${index + 1} of ${chargers.length} ("${charger?.name ?? 'unnamed'}") has no IP address, so it was skipped `
          + 'and its settings have no effect. Add its IP address, or delete that entry in the plugin settings.',
        );
        return;
      }
      const name = charger.name || 'Wall Connector';
      const host = charger.host.trim().toLowerCase();
      if (seenHosts.has(host)) {
        this.log.warn(
          `Wall Connector #${index + 1} of ${chargers.length} ("${name}") uses the same IP address as an earlier entry (${charger.host}), `
          + 'so it was skipped and its settings have no effect.',
        );
        return;
      }
      seenHosts.add(host);

      // Each tile is its own accessory, keyed by charger IP + role, so the Home app never groups them.
      const provide: AccessoryProvider = (role, displayName, category) => {
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${host}:${role}`);
        activeUuids.add(uuid);
        let accessory = this.cachedAccessories.get(uuid);
        if (accessory) {
          this.log.debug('Restoring accessory from cache:', accessory.displayName);
          accessory.context.charger = charger;
          this.api.updatePlatformAccessories([accessory]);
        } else {
          this.log.info('Adding accessory:', displayName);
          accessory = new this.api.platformAccessory(displayName, uuid, category);
          accessory.context.charger = charger;
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
        return accessory;
      };

      this.handlers.push(new WallConnector(this, charger, provide));
    });

    if (this.handlers.length === 0) {
      this.log.warn('No Wall Connectors with an IP address are configured, so nothing will show in HomeKit.');
    }

    const stale = [...this.cachedAccessories.values()].filter(a => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      // Covers tiles turned off in the config, removed chargers, and the single combined accessory used before 2.0.
      this.log.info('Removing accessories that were turned off, deleted from the config, or replaced:', stale.map(a => a.displayName).join(', '));
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
