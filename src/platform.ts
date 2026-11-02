import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { WallConnectorAccessory } from './accessory';
import { createEveCharacteristics, type EveCharacteristics } from './eve';
import { PLATFORM_NAME, PLUGIN_NAME, type ChargerConfig } from './settings';

export class TeslaWallConnectorPlatform implements DynamicPlatformPlugin {
  public readonly Service: API['hap']['Service'];
  public readonly Characteristic: API['hap']['Characteristic'];
  public readonly Eve: EveCharacteristics;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly handlers: WallConnectorAccessory[] = [];

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
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${charger.host.trim().toLowerCase()}`);
      if (activeUuids.has(uuid)) {
        this.log.warn(
          `Wall Connector #${index + 1} of ${chargers.length} ("${name}") uses the same IP address as an earlier entry (${charger.host}), `
          + 'so it was skipped and its settings have no effect.',
        );
        return;
      }
      activeUuids.add(uuid);

      let accessory = this.cachedAccessories.get(uuid);
      if (accessory) {
        this.log.info('Restoring Wall Connector from cache:', name);
        accessory.context.charger = charger;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding Wall Connector:', name);
        const category = charger.showOutlet ? this.api.hap.Categories.OUTLET : this.api.hap.Categories.SENSOR;
        accessory = new this.api.platformAccessory(name, uuid, category);
        accessory.context.charger = charger;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.handlers.push(new WallConnectorAccessory(this, accessory, charger));
    });

    if (this.handlers.length === 0) {
      this.log.warn('No Wall Connectors with an IP address are configured, so nothing will show in HomeKit.');
    }

    const stale = [...this.cachedAccessories.values()].filter(a => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info('Removing Wall Connectors no longer in config:', stale.map(a => a.displayName).join(', '));
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
