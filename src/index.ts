import type { API } from 'homebridge';

import { TeslaWallConnectorPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, TeslaWallConnectorPlatform);
};
