import { MODES, assert } from '@pollyjs/utils';

import { version } from '../package.json';

import Logger from './-private/logger';
import Container, { FactoryFn } from './-private/container';
import DefaultConfig, { PollyConfig } from './defaults/config';
import PollyRequest from './-private/request';
import guidForRecording from './utils/guid-for-recording';
import mergeConfigs from './utils/merge-configs';
import EventEmitter from './-private/event-emitter';
import Server from './server';
import { validateRecordingName } from './utils/validators';

type ValidMode = keyof typeof MODES;

interface FactoryRegistrationCallback {
  (container: Container): void;
}

const RECORDING_NAME = Symbol();
const RECORDING_ID = Symbol();
const PAUSED_MODE = Symbol();

const FACTORY_REGISTRATION: WeakMap<
  FactoryFn,
  FactoryRegistrationCallback
> = new WeakMap();
const EVENT_EMITTER = new EventEmitter({
  eventNames: ['register', 'create', 'stop']
});

/**
 * @export
 * @class Polly
 */
export default class Polly {
  public [RECORDING_NAME]: string;
  public [RECORDING_ID]: string;
  public [PAUSED_MODE]: string;
  public logger: Logger;
  public server: Server;
  public container: Container;
  public adapters: Map<string, Adapter>;
  public persister: Persister | null;
  private _requests: PollyRequest[];

  constructor(
    recordingName: string,
    public config: PollyConfig = { mode: 'REPLAY' }
  ) {
    this.recordingName = recordingName;
    this.logger = new Logger(this);
    this.server = new Server();
    this.container = new Container();

    EVENT_EMITTER.emitSync('register', this.container);

    /* running adapter instances */
    this.adapters = new Map();

    /* running persister instance */
    this.persister = null;

    /* requests over the lifetime of the polly instance */
    this._requests = [];

    this.logger.connect();
    EVENT_EMITTER.emitSync('create', this);
    this.configure(config);
  }

  /**
   * Package version.
   *
   * @readonly
   * @public
   * @memberof Polly
   */
  static get VERSION() {
    return version;
  }

  /**
   * @public
   * @memberof Polly
   */
  get recordingName() {
    return this[RECORDING_NAME];
  }

  set recordingName(name) {
    validateRecordingName(name);

    this[RECORDING_NAME] = name;
    this[RECORDING_ID] = guidForRecording(name);
  }

  /**
   * @readonly
   * @public
   * @memberof Polly
   */
  get recordingId() {
    return this[RECORDING_ID];
  }

  get mode(): ValidMode {
    return this.config.mode;
  }

  set mode(mode) {
    const possibleModes = Object.values(MODES);

    assert(
      `Invalid mode provided: "${uppercaseMode}". Possible modes: ${possibleModes.join(
        ', '
      )}.`,
      possibleModes.includes(uppercaseMode)
    );

    this.config.mode = uppercaseMode;
  }

  static on(eventName, listener) {
    EVENT_EMITTER.on(eventName, listener);

    return this;
  }

  static once(eventName, listener) {
    EVENT_EMITTER.once(eventName, listener);

    return this;
  }

  static off(eventName: string, listener) {
    EVENT_EMITTER.off(eventName, listener);

    return this;
  }

  static register(Factory: FactoryFn) {
    if (!FACTORY_REGISTRATION.has(Factory)) {
      FACTORY_REGISTRATION.set(Factory, container =>
        container.register(Factory)
      );
    }
    // TODO
    this.on('register', FACTORY_REGISTRATION.get(Factory));

    return this;
  }

  static unregister(Factory: FactoryFn) {
    if (FACTORY_REGISTRATION.has(Factory)) {
      this.off('register', FACTORY_REGISTRATION.get(Factory));
    }

    return this;
  }

  /**
   * @param {Object} [config={}]
   * @public
   * @memberof Polly
   */
  configure(config = {}) {
    const { container } = this;

    assert(
      'Cannot call `configure` once requests have been handled.',
      this._requests.length === 0
    );
    assert(
      'Cannot call `configure` on an instance of Polly that is not running.',
      this.mode !== MODES.STOPPED
    );

    // Disconnect from all current adapters before updating the config
    this.disconnect();

    this.config = mergeConfigs(DefaultConfig, this.config, config);

    // Register and connect to all specified adapters
    this.config.adapters.forEach(adapter => this.connectTo(adapter));

    /* Handle Persister */
    let { persister } = this.config;

    if (persister) {
      if (typeof persister === 'function') {
        container.register(persister);
        persister = persister.name;
      }

      assert(
        `Persister matching the name \`${persister}\` was not registered.`,
        container.has(`persister:${persister}`)
      );

      this.persister = new (container.lookup(`persister:${persister}`))(this);
    }
  }

  /**
   * @public
   * @memberof Polly
   */
  record() {
    this.mode = MODES.RECORD;
  }

  /**
   * @public
   * @memberof Polly
   */
  replay() {
    this.mode = MODES.REPLAY;
  }

  /**
   * @public
   * @memberof Polly
   */
  pause() {
    this[PAUSED_MODE] = this.mode;
    this.mode = MODES.PASSTHROUGH;
  }

  /**
   * @public
   * @memberof Polly
   */
  play() {
    if (this[PAUSED_MODE]) {
      this.mode = this[PAUSED_MODE];
      delete this[PAUSED_MODE];
    }
  }

  /**
   * @public
   * @memberof Polly
   */
  async stop() {
    if (this.mode !== MODES.STOPPED) {
      this.disconnect();
      this.logger.disconnect();
      await (this.persister && this.persister.persist());
      this.mode = MODES.STOPPED;

      await EVENT_EMITTER.emit('stop', this);
    }
  }

  async flush() {
    const NOOP = () => {};

    await Promise.all(
      // The NOOP is there to handle both a resolved and rejected promise
      // to ensure the promise resolves regardless of the outcome.
      this._requests.map(r => Promise.resolve(r.promise).then(NOOP, NOOP))
    );
  }

  /**
   * @param {String|Function} nameOrFactory
   * @public
   * @memberof Polly
   */
  connectTo(nameOrFactory: FactoryFn | string) {
    const { container, adapters } = this;
    let adapterName = nameOrFactory;

    if (typeof nameOrFactory === 'function') {
      container.register(nameOrFactory);
      adapterName = nameOrFactory.name;
    }

    assert(
      `Adapter matching the name \`${adapterName}\` was not registered.`,
      container.has(`adapter:${adapterName}`)
    );

    this.disconnectFrom(adapterName);

    const adapter = new (container.lookup(`adapter:${adapterName}`))(this);

    adapter.connect();
    adapters.set(adapterName, adapter);
  }

  /**
   * @param {String|Function} nameOrFactory
   * @public
   * @memberof Polly
   */
  disconnectFrom(nameOrFactory) {
    const { adapters } = this;
    let adapterName = nameOrFactory;

    if (typeof nameOrFactory === 'function') {
      adapterName = nameOrFactory.name;
    }

    if (adapters.has(adapterName)) {
      adapters.get(adapterName).disconnect();
      adapters.delete(adapterName);
    }
  }

  /**
   * @public
   * @memberof Polly
   */
  disconnect() {
    for (const adapterName of this.adapters.keys()) {
      this.disconnectFrom(adapterName);
    }
  }

  /**
   * @param {Object} [request={}]
   * @returns {PollyRequest}
   * @private
   * @memberof Polly
   */
  registerRequest(request = {}) {
    const pollyRequest = new PollyRequest(this, request);

    this._requests.push(pollyRequest);

    return pollyRequest;
  }
}