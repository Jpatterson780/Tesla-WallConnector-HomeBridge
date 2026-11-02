/**
 * Minimal client for the Tesla Wall Connector (Gen 3) local HTTP API.
 *
 * The API is unauthenticated, read-only and only reachable on the LAN.
 * Field names below match what current firmware returns; every field is
 * optional because older/newer firmware may add or drop some of them.
 */

export interface Vitals {
  contactor_closed?: boolean;
  vehicle_connected?: boolean;
  session_s?: number;
  grid_v?: number;
  grid_hz?: number;
  vehicle_current_a?: number;
  currentA_a?: number;
  currentB_a?: number;
  currentC_a?: number;
  currentN_a?: number;
  voltageA_v?: number;
  voltageB_v?: number;
  voltageC_v?: number;
  relay_coil_v?: number;
  pcba_temp_c?: number;
  handle_temp_c?: number;
  mcu_temp_c?: number;
  uptime_s?: number;
  input_thermopile_uv?: number;
  prox_v?: number;
  pilot_high_v?: number;
  pilot_low_v?: number;
  session_energy_wh?: number;
  config_status?: number;
  evse_state?: number;
  current_alerts?: unknown[];
}

export interface Lifetime {
  contactor_cycles?: number;
  contactor_cycles_loaded?: number;
  alert_count?: number;
  thermal_foldbacks?: number;
  avg_startup_temp?: number;
  charge_starts?: number;
  energy_wh?: number;
  connector_cycles?: number;
  uptime_s?: number;
  charging_time_s?: number;
}

export interface Version {
  firmware_version?: string;
  part_number?: string;
  serial_number?: string;
}

export class WallConnectorClient {
  private readonly baseUrl: string;

  constructor(host: string, private readonly timeoutMs: number) {
    const trimmed = host.trim().replace(/\/+$/, '');
    this.baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  getVitals(): Promise<Vitals> {
    return this.get<Vitals>('/api/1/vitals');
  }

  getLifetime(): Promise<Lifetime> {
    return this.get<Lifetime>('/api/1/lifetime');
  }

  getVersion(): Promise<Version> {
    return this.get<Version>('/api/1/version');
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${path}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Best-effort instantaneous power draw in watts.
 *
 * On three-phase installs each phase carries the vehicle current, so the
 * per-phase products are summed. On single/split-phase installs grid_v is the
 * full supply voltage (e.g. 240 V in North America) and vehicle_current_a is
 * the current through it.
 */
export function computePowerW(v: Vitals): number {
  // The current sensors read a few hundred mA of noise while idle.
  if (!v.contactor_closed) {
    return 0;
  }
  const threePhase = (v.voltageC_v ?? 0) > 50 && (v.currentC_a ?? 0) > 0.5;
  if (threePhase) {
    return (v.currentA_a ?? 0) * (v.voltageA_v ?? 0)
      + (v.currentB_a ?? 0) * (v.voltageB_v ?? 0)
      + (v.currentC_a ?? 0) * (v.voltageC_v ?? 0);
  }
  return (v.vehicle_current_a ?? 0) * (v.grid_v ?? 0);
}

/** Vehicle charging current in amps, or 0 while the contactor is open. */
export function chargingCurrentA(v: Vitals): number {
  return v.contactor_closed ? (v.vehicle_current_a ?? 0) : 0;
}
