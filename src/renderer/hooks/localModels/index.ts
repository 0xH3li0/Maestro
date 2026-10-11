/**
 * Local Models Module - the renderer side of the core Local Models service.
 *
 * Listing, downloading, verifying, and deleting local models, and installing the
 * native runtimes they run on. Consumers with their own gated channels (A
 * Cappella) wrap these hooks rather than keeping a second state machine.
 */

export { useLocalModels } from './useLocalModels';
export type { LocalModelsSource, LocalModelsState, UseLocalModelsOptions } from './useLocalModels';
export { useLocalRuntimes } from './useLocalRuntimes';
export type {
	LocalRuntimesSource,
	LocalRuntimesState,
	UseLocalRuntimesOptions,
} from './useLocalRuntimes';
export { useLocalModelEndpoints } from './useLocalModelEndpoints';
export type {
	EndpointCallFailure,
	EndpointModelsState,
	EndpointTestState,
	EndpointTestVerdict,
	LocalModelEndpointsState,
} from './useLocalModelEndpoints';
