import { copyJson, type Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  configure,
  defineDoc,
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  type DocumentReader,
  type Harness,
  type JsonObject,
  type Tx,
} from "@earendil-works/pi-durable";
import { routeAtEffort, type RouteConfig } from "../route.ts";
import type {
  AgentRouteBinding,
  AgentRouteRuntime,
  CreateRouteProvider,
} from "./contracts.ts";

type StoredBinding = Omit<AgentRouteBinding, "mode"> & {
  readonly mode:
    | { readonly kind: "normal" }
    | { readonly kind: "final"; readonly schema: JsonObject };
};

/**
 * The conversation's route, committed before its first request. A fork starts with none here, and
 * `clearInheritedAgentRoute` drops the route alias its `pi.agent` model inherited.
 */
const AgentRouteDoc = defineDoc<{ binding: StoredBinding | null }>({
  kind: "neuve.agent-route",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ binding: null }),
});

const SCAN_PAGE = 256;

const ROUTE_ALIAS_PREFIX = "neuve-route:";

/**
 * The run harness's `HarnessOptions.conversationCreated`, installed before any conversation is
 * created or forked. A fork keeps its parent's `pi.agent` and a task-owned conversation copies its
 * owner's, so either would inherit a route alias whose provider serves the other conversation's
 * binding. Clearing the model leaves it on pi's no-model failure until its own binding's model is
 * configured.
 */
export const clearInheritedAgentRoute = async (
  tx: Tx,
  conversation: ConversationRecord,
): Promise<void> => {
  const agent = await tx.doc(AgentDoc, conversation.id);
  if (agent.model?.provider.startsWith(ROUTE_ALIAS_PREFIX) === true) {
    await configure(tx, conversation.id, { model: null });
  }
};

const sameRoute = (a: StoredBinding, b: StoredBinding) =>
  a.runId === b.runId &&
  a.stage === b.stage &&
  a.agent === b.agent &&
  a.conversationId === b.conversationId &&
  a.logicalProvider === b.logicalProvider &&
  a.physicalProvider === b.physicalProvider &&
  a.physicalModel === b.physicalModel &&
  a.effort === b.effort;

const describe = (binding: StoredBinding) =>
  `${binding.stage}/${binding.agent} on ${binding.physicalProvider}/${binding.physicalModel}${binding.effort === undefined ? "" : ` at ${binding.effort} effort`}`;

/**
 * The route a binding's provider is built with: the run's, at the binding's effort when it has one.
 * A binding stored before steps had their own effort has none and runs at the route's.
 */
export const bindingRoute = <R extends RouteConfig>(
  route: R,
  binding: Pick<AgentRouteBinding, "effort">,
): R => routeAtEffort(route, binding.effort ?? route.effort);

/**
 * The effort a conversation's requests are made at, from its stored binding by the rule its
 * provider is built with (`bindingRoute`): the route's when the binding has none, or there is none.
 */
export const boundEffort = async (
  read: DocumentReader,
  conversationId: ConversationId,
  route: RouteConfig,
  context: Context,
) => {
  const doc = await read.snapshot(AgentRouteDoc, conversationId, context);
  return bindingRoute(route, doc?.binding ?? {}).effort;
};

const finalSchema = (schema: unknown): JsonObject => {
  const copy = copyJson(schema);
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) {
    throw new TypeError("The final-generation schema must be a JSON object");
  }
  return copy;
};

export const agentRoutes = (options: {
  readonly harness: Harness;
  readonly models: MutableModels;
  readonly runId: string;
  readonly createProvider: CreateRouteProvider;
}): AgentRouteRuntime => {
  const { harness, models, runId, createProvider } = options;

  const readBinding = async (
    conversationId: ConversationId,
    context: Context,
  ): Promise<AgentRouteBinding> => {
    const doc = await harness.snapshot(AgentRouteDoc, conversationId, context);
    if (doc === undefined || doc.binding === null) {
      throw new Error(
        `Conversation ${conversationId} has no agent route; it is never attributed to another agent`,
      );
    }
    return doc.binding;
  };

  const registered = new Set<string>();

  const register = (binding: AgentRouteBinding) => {
    if (registered.has(binding.logicalProvider)) return;
    // The provider reads at dispatch, where pi passes no Context; a committed read needs none.
    const provider = createProvider(binding, () =>
      readBinding(binding.conversationId, BACKGROUND_CONTEXT),
    );
    if (provider.id !== binding.logicalProvider) {
      throw new Error(
        `The routed provider for conversation ${binding.conversationId} is ${provider.id}, not ${binding.logicalProvider}`,
      );
    }
    models.setProvider(provider);
    registered.add(binding.logicalProvider);
  };

  return {
    readBinding,

    bindAgentRoute: async (
      { conversationId, stage, agent, route, reading, effort },
      context,
    ) => {
      const wanted: StoredBinding = {
        runId,
        stage,
        agent,
        conversationId,
        logicalProvider: `${ROUTE_ALIAS_PREFIX}${runId}:${conversationId}`,
        physicalProvider: route.provider,
        physicalModel: route.model,
        // Only an effort that is not the route's is stored, so a default binding is as before.
        ...(effort === undefined || effort === route.effort ? {} : { effort }),
        mode: { kind: "normal" },
        // Scheduling advice, not identity: `sameRoute` leaves it out, and a binding without it reads as none.
        ...(reading === undefined
          ? {}
          : {
              reading: {
                kind: reading.kind,
                rank: reading.rank,
                ...(reading.reread === true ? { reread: true } : {}),
              },
            }),
      };
      await harness.commit(async (tx) => {
        const doc = await tx.doc(AgentRouteDoc, conversationId);
        if (doc.binding === null) {
          doc.binding = wanted;
        } else if (!sameRoute(doc.binding, wanted)) {
          throw new Error(
            `Conversation ${conversationId} is bound to ${describe(doc.binding)}; refusing ${describe(wanted)}`,
          );
        }
      }, context);
      const binding = await readBinding(conversationId, context);
      register(binding);
      return {
        provider: binding.logicalProvider,
        modelId: binding.physicalModel,
      };
    },

    prepareFinalGeneration: async ({ conversationId, schema }, context) => {
      const stored = finalSchema(schema);
      await harness.commit(async (tx) => {
        const doc = await tx.doc(AgentRouteDoc, conversationId);
        if (doc.binding === null) {
          throw new Error(
            `Conversation ${conversationId} has no agent route to finish`,
          );
        }
        doc.binding.mode = { kind: "final", schema: stored };
      }, context);
    },

    restoreAgentRoutes: async (context) => {
      let cursor: Cursor | undefined;
      do {
        const page = await harness.commit(
          (tx) => tx.scanConversations({}, SCAN_PAGE, cursor),
          context,
        );
        for (const conversation of page.items) {
          const doc = await harness.snapshot(
            AgentRouteDoc,
            conversation.id,
            context,
          );
          if (doc !== undefined && doc.binding !== null) register(doc.binding);
        }
        cursor = page.next;
      } while (cursor !== undefined);
    },
  };
};
