import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge' with { 'resolution-mode': 'import' };
import { Syncleo, parseShareLink } from './syncleo';

const plugin = 'homebridge-ballu-syncleo';
const platform = 'BalluSyncleo';
type State = Awaited<ReturnType<Syncleo['exchange']>>;

type DeviceConfig = { name?: string; shareLink?: string };

class BalluPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly devices = new Map<string, BalluDevice>();

  constructor(private readonly log: Logger, config: PlatformConfig, private readonly api: API) {
    const path = api.user.configPath();
    const reload = () => {
      try {
        const file = JSON.parse(readFileSync(path, 'utf8')) as { platforms?: PlatformConfig[] };
        if (!Array.isArray(file.platforms)) return;
        const next = file.platforms.find(entry => entry.platform === platform || entry.platform === plugin + '.' + platform);
        this.apply(next);
      } catch {
        // Retry transient read failures on the next file change.
      }
    };
    api.on('didFinishLaunching', () => {
      this.apply(config);
      watchFile(path, { interval: 1000, persistent: false }, reload);
      reload();
    });
    api.on('shutdown', () => {
      unwatchFile(path, reload);
      for (const device of this.devices.values()) device.disconnect();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  private apply(config?: PlatformConfig) {
    const entries: DeviceConfig[] = Array.isArray(config?.devices) ? config.devices
      : config?.shareLink ? [config] : [];
    const next = new Map<string, { link: string; name: string; mac: string }>();
    try {
      for (const entry of entries) {
        const link = entry.shareLink?.trim() ?? '';
        const name = entry.name?.trim() || 'Ballu ASP-100';
        const { mac } = parseShareLink(link);
        const uuid = this.api.hap.uuid.generate(mac);
        if (next.has(uuid)) throw new Error('duplicate device');
        next.set(uuid, { link, name, mac });
      }
    } catch {
      this.log.error('Invalid or duplicate Ballu configuration / Некорректная или повторяющаяся настройка Ballu');
      return;
    }
    for (const [uuid, details] of next) {
      const current = this.devices.get(uuid);
      if (current?.link === details.link && current.name === details.name) continue;
      current?.disconnect();
      const device = new BalluDevice(this.log, this.api, details.link, details.name);
      const cached = this.cached.get(uuid);
      const accessory = cached ?? new this.api.platformAccessory(details.name, uuid);
      device.launch(accessory, details.mac, Boolean(cached));
      this.cached.set(uuid, accessory);
      this.devices.set(uuid, device);
      this.log.info('Ballu configuration applied / Настройки Ballu применены');
    }
    for (const [uuid, accessory] of this.cached) {
      if (next.has(uuid)) continue;
      this.devices.get(uuid)?.disconnect();
      this.devices.delete(uuid);
      this.api.unregisterPlatformAccessories(plugin, platform, [accessory]);
      this.cached.delete(uuid);
    }
  }
}

class BalluDevice {
  private client?: Syncleo;
  private timer?: NodeJS.Timeout;
  private fan?: Service;
  private refresh?: Promise<void>;
  private offline = false;
  private state?: State;
  private pendingWrites = 0;
  private speedTimer?: NodeJS.Timeout;
  private speedWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(private readonly log: Logger, private readonly api: API,
    readonly link: string, readonly name: string) {}

  disconnect() {
    clearInterval(this.timer);
    clearTimeout(this.speedTimer);
    this.speedTimer = undefined;
    for (const waiter of this.speedWaiters.splice(0)) waiter.reject(new Error('Syncleo configuration changed'));
    this.client?.stop();
    this.client = undefined;
    this.refresh = undefined;
    this.state = undefined;
    this.offline = false;
  }

  launch(accessory: PlatformAccessory, mac: string, cached: boolean) {
    const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    const client = new Syncleo(this.link);
    this.client = client;
    const name = this.name;
    const fan = accessory.getService(Service.Fanv2) ?? accessory.addService(Service.Fanv2, name);
    this.fan = fan;
    accessory.displayName = name;
    fan.setCharacteristic(Characteristic.Name, name);
    accessory.getService(Service.AccessoryInformation)?.setCharacteristic(Characteristic.Manufacturer, 'Ballu')
      .setCharacteristic(Characteristic.Model, 'ONEAIR ASP-100')
      .setCharacteristic(Characteristic.SerialNumber, mac.toUpperCase());
    const read = () => {
      if (this.client === client && this.state && !this.offline) return this.state;
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    };
    const write = async (commands: Array<[number, number]>) => {
      if (this.client !== client) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      this.pendingWrites++;
      try {
        const state = await client.exchange(commands);
        if (this.client !== client) throw new Error('Syncleo configuration changed');
        this.state = state;
        this.offline = false;
        if (this.pendingWrites === 1 && !this.speedTimer) this.update(state, accessory, name);
      } catch (error) {
        this.log.warn('ASP-100 command failed: %s', error instanceof Error ? error.message : 'unknown error');
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } finally {
        this.pendingWrites--;
      }
    };
    fan.getCharacteristic(Characteristic.Active)
      .onGet(() => Number(read().mode !== 0))
      .onSet(value => {
        if (this.client !== client) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        if (this.speedTimer) {
          clearTimeout(this.speedTimer);
          this.speedTimer = undefined;
          for (const waiter of this.speedWaiters.splice(0)) waiter.resolve();
        }
        return write([[1, Number(value) ? 1 : 0]]);
      });
    fan.getCharacteristic(Characteristic.RotationSpeed)
      .onGet(() => this.percent(read()))
      .onSet(value => new Promise<void>((resolve, reject) => {
        if (this.client !== client) {
          reject(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
          return;
        }
        clearTimeout(this.speedTimer);
        this.speedWaiters.push({ resolve, reject });
        this.speedTimer = setTimeout(() => {
          this.speedTimer = undefined;
          const waiters = this.speedWaiters.splice(0);
          const speed = Math.max(1, Math.min(7, Math.round(Number(value) * 7 / 100)));
          void write(Number(value) === 0 ? [[1, 0]] : [[1, 1], [15, speed]]).then(
            () => { for (const waiter of waiters) waiter.resolve(); },
            error => { for (const waiter of waiters) waiter.reject(error); },
          );
        }, 250);
      }));
    if (cached) this.api.updatePlatformAccessories([accessory]);
    else this.api.registerPlatformAccessories(plugin, platform, [accessory]);
    const refresh = () => {
      if (this.client !== client || this.pendingWrites || this.speedTimer) return;
      this.refresh ??= client.exchange().then(state => {
        if (this.client !== client) return;
        this.state = state;
        if (!this.pendingWrites && !this.speedTimer) this.update(state, accessory, name);
        if (this.offline) this.log.info('ASP-100 online / Бризер на связи');
        this.offline = false;
      }).catch(() => {
        if (this.client !== client) return;
        accessory.getService(Service.CarbonDioxideSensor)
          ?.updateCharacteristic(Characteristic.StatusActive, false);
        if (!this.offline) this.log.warn('ASP-100 unavailable / Бризер недоступен');
        this.offline = true;
      }).finally(() => {
        if (this.client === client) this.refresh = undefined;
      });
    };
    client.on('discovered', refresh);
    client.on('networkError', () => this.log.warn('mDNS socket error / Ошибка mDNS'));
    client.start();
    this.timer = setInterval(refresh, 15000);
  }

  private percent(state: { mode: number; speed: number }) {
    return state.mode === 0 ? 0 : Math.round(Math.min(7, state.speed) * 100 / 7);
  }

  private update(state: State, accessory: PlatformAccessory, name: string) {
    const { Characteristic, Service } = this.api.hap;
    if (state.firmware) {
      accessory.getService(Service.AccessoryInformation)
        ?.updateCharacteristic(Characteristic.FirmwareRevision, state.firmware);
    }
    if (state.co2 !== undefined) {
      const existing = accessory.getService(Service.CarbonDioxideSensor);
      const sensor = existing ?? accessory.addService(Service.CarbonDioxideSensor, name + ' CO₂', 'co2');
      sensor.updateCharacteristic(Characteristic.StatusActive, true);
      sensor.updateCharacteristic(Characteristic.CarbonDioxideLevel, state.co2);
      sensor.updateCharacteristic(Characteristic.CarbonDioxideDetected, Number(state.co2 >= 1000));
      if (!existing) this.api.updatePlatformAccessories([accessory]);
    }
    this.fan?.updateCharacteristic(Characteristic.Active, Number(state.mode !== 0));
    this.fan?.updateCharacteristic(Characteristic.RotationSpeed, this.percent(state));
  }
}

export = (api: API) => api.registerPlatform(platform, BalluPlatform);
