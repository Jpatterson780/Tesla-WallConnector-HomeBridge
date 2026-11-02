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

    for (const charger of chargers) {
      if (!charger?.host) {
        this.log.warn('Skipping Wall Connector with no host configured:', charger?.name ?? '(unnamed)');
        continue;
      }
      const name = charger.name || 'Wall Connector';
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${charger.host.trim().toLowerCase()}`);
      if (activeUuids.has(uuid)) {
        this.log.warn(`Duplicate Wall Connector host "${charger.host}" ignored.`);
        continue;
      }
      activeUuids.add(uuid);

      let accessory = this.cachedAccessories.get(uuid);
      if (accessory) {
        this.log.info('Restoring Wall Connector from cache:', name);
        accessory.context.charger = charger;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding Wall Connector:', name);
        accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.OUTLET);
        accessory.context.charger = charger;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.handlers.push(new WallConnectorAccessory(this, accessory, charger));
    }

    const stale = [...this.cachedAccessories.values()].filter(a => !activeUuids.has(a.UUID));
    if (stale.length > 0) {
      this.log.info('Removing Wall Connectors no longer in config:', stale.map(a => a.displayName).join(', '));
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
