import type { API, Characteristic, WithUUID } from 'homebridge';

/**
 * Eve-compatible power metering characteristics. Apple's Home app ignores
 * them, but Eve, Controller for HomeKit, Home+ etc. display them on the
 * outlet tile and can use them in automations.
 */
export interface EveCharacteristics {
  Voltage: WithUUID<new () => Characteristic>;
  ElectricCurrent: WithUUID<new () => Characteristic>;
  CurrentConsumption: WithUUID<new () => Characteristic>;
  TotalConsumption: WithUUID<new () => Characteristic>;
}

export function createEveCharacteristics(api: API): EveCharacteristics {
  const { Characteristic, Formats, Perms } = api.hap;

  const define = (displayName: string, uuid: string, unit: string, maxValue: number, minStep: number) => {
    return class extends Characteristic {
      static readonly UUID = uuid;

      constructor() {
        super(displayName, uuid, {
          format: Formats.FLOAT,
          unit,
          minValue: 0,
          maxValue,
          minStep,
          perms: [Perms.PAIRED_READ, Perms.NOTIFY],
        });
        this.value = 0;
      }
    };
  };

  return {
    Voltage: define('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52', 'V', 1000, 0.1),
    ElectricCurrent: define('Electric Current', 'E863F126-079E-48FF-8F27-9C2605A29F52', 'A', 1000, 0.1),
    CurrentConsumption: define('Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52', 'W', 100000, 1),
    TotalConsumption: define('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52', 'kWh', 10000000, 0.001),
  };
}
