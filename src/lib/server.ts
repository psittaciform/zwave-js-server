import ws from "ws";
import type WebSocket from "ws";
import {
  getResponder,
  CiaoService,
  Protocol,
  Responder,
} from "@homebridge/ciao";
import { Driver, InclusionGrant, ZWaveError, ZWaveErrorCodes } from "zwave-js";
import { libVersion } from "zwave-js";
import { DeferredPromise } from "alcalzone-shared/deferred-promise";
import { EventForwarder } from "./forward";
import type * as OutgoingMessages from "./outgoing_message";
import { IncomingMessage } from "./incoming_message";
import { dumpLogConfig, dumpState } from "./state";
import { Server as HttpServer, createServer } from "http";
import { EventEmitter, once } from "events";
import {
  dnssdServiceType,
  version,
  minSchemaVersion,
  maxSchemaVersion,
  applicationName,
} from "./const";
import { NodeMessageHandler } from "./node/message_handler";
import { ControllerMessageHandler } from "./controller/message_handler";
import { IncomingMessageController } from "./controller/incoming_message";
import {
  BaseError,
  ErrorCode,
  SchemaIncompatibleError,
  UnknownCommandError,
} from "./error";
import { Instance } from "./instance";
import { IncomingMessageNode } from "./node/incoming_message";
import { ServerCommand } from "./command";
import { DriverMessageHandler } from "./driver/message_handler";
import { IncomingMessageDriver } from "./driver/incoming_message";
import { LogContexts, LoggingEventForwarder } from "./logging";
import { BroadcastNodeMessageHandler } from "./broadcast_node/message_handler";
import { IncomingMessageBroadcastNode } from "./broadcast_node/incoming_message";
import { MulticastGroupMessageHandler } from "./multicast_group/message_handler";
import { IncomingMessageMulticastGroup } from "./multicast_group/incoming_message";
import { EndpointMessageHandler } from "./endpoint/message_handler";
import { IncomingMessageEndpoint } from "./endpoint/incoming_message";
import { UtilsMessageHandler } from "./utils/message_handler";
import { IncomingMessageUtils } from "./utils/incoming_message";

export class Client {
  public receiveEvents = false;
  private _outstandingPing = false;
  public schemaVersion = minSchemaVersion;
  public receiveLogs = false;
  public additionalUserAgentComponents?: Record<string, string>;

  private instanceHandlers: Record<
    Instance,
    (
      message: IncomingMessage
    ) => Promise<OutgoingMessages.OutgoingResultMessageSuccess["result"]>
  > = {
    [Instance.controller]: (message) =>
      ControllerMessageHandler.handle(
        message as IncomingMessageController,
        this.clientsController,
        this.driver,
        this
      ),
    [Instance.driver]: (message) =>
      DriverMessageHandler.handle(
        message as IncomingMessageDriver,
        this.clientsController,
        this.driver,
        this
      ),
    [Instance.node]: (message) =>
      this.clientsController.nodeMessageHandler.handle(
        message as IncomingMessageNode,
        this.driver,
        this.clientsController,
        this
      ),
    [Instance.multicast_group]: (message) =>
      MulticastGroupMessageHandler.handle(
        message as IncomingMessageMulticastGroup,
        this.driver
      ),
    [Instance.broadcast_node]: (message) =>
      BroadcastNodeMessageHandler.handle(
        message as IncomingMessageBroadcastNode,
        this.driver
      ),
    [Instance.endpoint]: (message) =>
      EndpointMessageHandler.handle(
        message as IncomingMessageEndpoint,
        this.driver,
        this
      ),
    [Instance.utils]: (message) =>
      UtilsMessageHandler.handle(message as IncomingMessageUtils),
  };

  constructor(
    private socket: WebSocket,
    private clientsController: ClientsController,
    private driver: Driver,
    private logger: Logger
  ) {
    socket.on("pong", () => {
      this._outstandingPing = false;
    });
    socket.on("message", (data: string) => this.receiveMessage(data));
  }

  get isConnected(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  private setSchemaVersion(schemaVersion: number) {
    // Handle schema version
    this.schemaVersion = schemaVersion;
    if (
      this.schemaVersion < minSchemaVersion ||
      this.schemaVersion > maxSchemaVersion
    ) {
      throw new SchemaIncompatibleError(this.schemaVersion);
    }
  }

  async receiveMessage(data: string) {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      // We don't have the message ID. Just close it.
      this.logger.debug(`Unable to parse data: ${data}`);
      this.socket.close();
      return;
    }

    try {
      if (msg.command === ServerCommand.initialize) {
        this.setSchemaVersion(msg.schemaVersion);
        this.additionalUserAgentComponents = msg.additionalUserAgentComponents;
        this.sendResultSuccess(msg.messageId, {});
        return;
      }

      if (msg.command === ServerCommand.setApiSchema) {
        this.setSchemaVersion(msg.schemaVersion);
        this.sendResultSuccess(msg.messageId, {});
        return;
      }

      if (msg.command === ServerCommand.startListening) {
        this.sendResultSuccess(
          msg.messageId,
          {
            state: dumpState(this.driver, this.schemaVersion),
          },
          true
        );
        this.receiveEvents = true;
        return;
      }

      if (msg.command === ServerCommand.updateLogConfig) {
        this.driver.updateLogConfig(msg.config);
        this.sendResultSuccess(msg.messageId, {});
        return;
      }

      if (msg.command === ServerCommand.getLogConfig) {
        this.sendResultSuccess(msg.messageId, {
          config: dumpLogConfig(this.driver, this.schemaVersion),
        });
        return;
      }

      const instance = msg.command.split(".")[0] as Instance;
      if (this.instanceHandlers[instance]) {
        return this.sendResultSuccess(
          msg.messageId,
          await this.instanceHandlers[instance](msg)
        );
      }

      throw new UnknownCommandError(msg.command);
    } catch (err: unknown) {
      if (err instanceof BaseError) {
        this.logger.error("Message error", err);
        const { errorCode, name, message, stack, ...args } = err;
        return this.sendResultError(msg.messageId, errorCode, args);
      }
      if (err instanceof ZWaveError) {
        this.logger.error("Z-Wave error", err);
        return this.sendResultZWaveError(msg.messageId, err.code, err.message);
      }

      this.logger.error("Unexpected error", err as Error);
      this.sendResultError(msg.messageId, ErrorCode.unknownError, {});
    }
  }

  sendVersion() {
    this.sendData({
      type: "version",
      driverVersion: libVersion,
      serverVersion: version,
      homeId: this.driver.controller.homeId,
      minSchemaVersion: minSchemaVersion,
      maxSchemaVersion: maxSchemaVersion,
    });
  }

  sendResultSuccess(
    messageId: string,
    result: OutgoingMessages.OutgoingResultMessageSuccess["result"],
    compress = false
  ) {
    this.sendData(
      {
        type: "result",
        success: true,
        messageId,
        result,
      },
      compress
    );
  }

  sendResultError(
    messageId: string,
    errorCode: Omit<ErrorCode, "zwaveError">,
    args: OutgoingMessages.JSONValue
  ) {
    this.sendData({
      type: "result",
      success: false,
      messageId,
      errorCode,
      args,
    });
  }

  sendResultZWaveError(
    messageId: string,
    zjsErrorCode: ZWaveErrorCodes,
    message: string
  ) {
    this.sendData({
      type: "result",
      success: false,
      messageId,
      errorCode: ErrorCode.zwaveError,
      zwaveErrorCode: zjsErrorCode,
      zwaveErrorMessage: message,
    });
  }

  sendEvent(event: OutgoingMessages.OutgoingEvent) {
    this.sendData({
      type: "event",
      event,
    });
  }

  sendData(data: OutgoingMessages.OutgoingMessage, compress = false) {
    this.socket.send(JSON.stringify(data), { compress });
  }

  checkAlive() {
    if (this._outstandingPing) {
      this.disconnect();
      return;
    }
    this._outstandingPing = true;
    this.socket.ping();
  }

  disconnect() {
    this.socket.close();
  }
}
export class ClientsController extends EventEmitter {
  public clients: Array<Client> = [];
  private pingInterval?: NodeJS.Timeout;
  private eventForwarder?: EventForwarder;
  private cleanupScheduled = false;
  private loggingEventForwarder?: LoggingEventForwarder;
  public grantSecurityClassesPromise?: DeferredPromise<InclusionGrant | false>;
  public validateDSKAndEnterPinPromise?: DeferredPromise<string | false>;
  public nodeMessageHandler = new NodeMessageHandler();

  constructor(public driver: Driver, private logger: Logger) {
    super();
  }

  addSocket(socket: WebSocket) {
    this.logger.debug("New client");
    const client = new Client(socket, this, this.driver, this.logger);
    socket.on("error", (error) => {
      this.logger.error("Client socket error", error);
    });
    socket.on("close", (code, reason) => {
      this.logger.info("Client disconnected");
      this.logger.debug(`Code ${code}: ${reason}`);
      this.scheduleClientCleanup();
    });
    client.sendVersion();
    this.clients.push(client);

    if (this.pingInterval === undefined) {
      this.pingInterval = setInterval(() => {
        const newClients = [];

        for (const client of this.clients) {
          if (client.isConnected) {
            newClients.push(client);
          } else {
            client.disconnect();
          }
        }

        this.clients = newClients;
      }, 30000);
    }

    if (this.eventForwarder === undefined) {
      this.eventForwarder = new EventForwarder(this);
      this.eventForwarder.start();
    }
  }

  get loggingEventForwarderStarted(): boolean {
    return this.loggingEventForwarder?.started === true;
  }

  public restartLoggingEventForwarderIfNeeded() {
    this.loggingEventForwarder?.restartIfNeeded();
  }

  public configureLoggingEventForwarder(filter?: Partial<LogContexts>) {
    if (this.loggingEventForwarder === undefined) {
      this.loggingEventForwarder = new LoggingEventForwarder(
        this,
        this.driver,
        this.logger
      );
    }
    if (!this.loggingEventForwarderStarted) {
      this.loggingEventForwarder?.start(filter);
    }
  }

  public cleanupLoggingEventForwarder() {
    if (
      this.clients.filter((cl) => cl.receiveLogs).length == 0 &&
      this.loggingEventForwarderStarted
    ) {
      this.loggingEventForwarder?.stop();
    }
  }

  private scheduleClientCleanup() {
    if (this.cleanupScheduled) {
      return;
    }
    this.cleanupScheduled = true;
    setTimeout(() => this.cleanupClients(), 0);
  }

  private cleanupClients() {
    this.cleanupScheduled = false;
    this.clients = this.clients.filter((cl) => cl.isConnected);
    this.cleanupLoggingEventForwarder();
  }

  disconnect() {
    if (this.pingInterval !== undefined) {
      clearInterval(this.pingInterval);
    }
    this.pingInterval = undefined;
    this.clients.forEach((client) => client.disconnect());
    this.clients = [];
    this.cleanupLoggingEventForwarder();
  }
}

interface ZwavejsServerOptions {
  port?: number;
  host?: string;
  logger?: Logger;
  enableDNSServiceDiscovery?: boolean;
}

export interface Logger {
  error(message: string | Error, error?: Error): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export class ZwavejsServer extends EventEmitter {
  private server?: HttpServer;
  private wsServer?: ws.Server;
  private sockets?: ClientsController;
  private logger: Logger;
  private defaultPort: number = 3000;
  private defaultHost: string = "0.0.0.0";
  private responder?: Responder;
  private service?: CiaoService;

  constructor(
    private driver: Driver,
    private options: ZwavejsServerOptions = {},
    private destroyServerOnHardReset: boolean = false
  ) {
    super();
    this.logger = options.logger ?? console;
  }

  async start() {
    if (!this.driver.ready) {
      throw new Error("Cannot start server when driver not ready");
    }

    this.driver.updateUserAgent({ [applicationName]: version });
    this.server = createServer();
    this.wsServer = new ws.Server({
      server: this.server,
      perMessageDeflate: true,
    });
    this.sockets = new ClientsController(this.driver, this.logger);
    this.sockets.on("hard reset", async () => {
      this.driver.once("driver ready", () => this.start());
      await this.driver.hardReset();
      if (this.destroyServerOnHardReset) {
        await this.destroy();
      }
      this.emit("hard reset");
    });
    this.wsServer.on("connection", (socket) => this.sockets!.addSocket(socket));

    const port = this.options.port || this.defaultPort;
    const host = this.options.host || this.defaultHost;
    const localEndpointString = `${host}:${port}`;

    this.logger.debug(`Starting server on ${localEndpointString}`);

    this.wsServer.on("error", this.onError.bind(this, this.wsServer));
    this.server.on("error", this.onError.bind(this, this.server));
    this.server.listen(port, host);
    await once(this.server, "listening");
    this.emit("listening");
    this.logger.info(`ZwaveJS server listening on ${localEndpointString}`);
    if (this.options.enableDNSServiceDiscovery) {
      this.responder = getResponder();
      this.service = this.responder.createService({
        name: this.driver.controller.homeId!.toString(),
        port,
        type: dnssdServiceType,
        protocol: Protocol.TCP,
        txt: {
          homeId: this.driver.controller.homeId!,
        },
      });
      this.service.advertise().then(() => {
        this.logger.info(`DNS Service Discovery enabled`);
      });
    }
  }

  private onError(sourceClass: EventEmitter, error: Error) {
    this.emit("error", error, sourceClass);
    this.logger.error(error);
  }

  async destroy() {
    this.logger.debug(`Closing server...`);
    if (this.sockets) {
      this.sockets.disconnect();
      this.sockets.removeAllListeners();
      delete this.sockets;
    }
    if (this.wsServer) {
      this.wsServer.close();
      await once(this.wsServer, "close");
      this.wsServer.removeAllListeners();
      delete this.wsServer;
    }
    if (this.server) {
      this.server.close();
      await once(this.server, "close");
      this.server.removeAllListeners();
      delete this.server;
    }
    if (this.service) {
      await this.service.end();
      await this.service.destroy();
      this.service.removeAllListeners();
      delete this.service;
    }
    if (this.responder) {
      await this.responder.shutdown();
      delete this.responder;
    }
    this.logger.info(`Server closed`);
  }
}
