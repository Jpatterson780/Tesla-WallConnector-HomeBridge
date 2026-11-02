export const PLATFORM_NAME = 'TeslaWallConnectorLocal';
export const PLUGIN_NAME = 'homebridge-tesla-wall-connector-local';

export interface ChargerConfig {
  name: string;
  host: string;
  pollInterval?: number;
  timeout?: number;
  showOutlet?: boolean;
  showVehicleConnectedSensor?: boolean;
  showChargingSensor?: boolean;
  showHandleTemperature?: boolean;
  showPcbaTemperature?: boolean;
  showMcuTemperature?: boolean;
}

export const DEFAULT_POLL_INTERVAL_S = 15;
export const MIN_POLL_INTERVAL_S = 5;
export const DEFAULT_TIMEOUT_S = 5;
