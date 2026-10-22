export { MessagingModule } from './messaging.module';
export { MESSAGING_CONFIG, DEFAULT_PREFETCH, loadMessagingConfig, redactUrl } from './config';
export type { MessagingConfig } from './config';

export {
  RETRY_DELAYS_MS,
  MAX_DELIVERY_RETRIES,
  ALL_EVENT_QUEUES,
  retryQueueName,
  deadLetterQueueName,
  isEventQueue,
  describeTopology,
  assertTopology,
} from './topology';

export type { Topology, QueueTopology, RetryQueue } from './topology';

export {
  RabbitConnection,
  MessagingUnavailableError,
  UnroutableMessageError,
} from './rabbit-connection';

export type { ConnectionSetup } from './rabbit-connection';
export { EventPublisher, createRideEvent } from './event-publisher';
export type { CreateEventInput } from './event-publisher';

export {
  EventConsumer,
  NonRetryableEventError,
  handleDelivery,
  RETRY_COUNT_HEADER,
  ERROR_CODE_HEADER,
  ERROR_MESSAGE_HEADER,
} from './event-consumer';

export type {
  EventHandler,
  EventHandlers,
  DeliveryContext,
  DeliveryOutcome,
  ConfirmedSender,
} from './event-consumer';

export { enqueueOutboxEvent, OutboxRelay } from './outbox';
export type { OutboxRelayOptions } from './outbox';
export { recordProcessedEvent, processEventOnce } from './inbox';
export type { InboxOptions, ProcessOnceResult } from './inbox';
export { outboxTableDdl, processedEventsTableDdl } from './sql';
