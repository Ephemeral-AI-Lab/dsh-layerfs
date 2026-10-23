// Keeps the scripted model off dsh's default model.
import { PROVIDER } from "./adapter.js";

// dsh saves every Session's model pick as the default for new Sessions. A run
// picks its scenario's model on its own Session, so without this the last run
// would become everyone's default: a scripted model is kept off the default,
// and other picks are saved as before.
export function keepDefaultModel(ctx) {
  const service = ctx.agentDefaultModel, save = service.saveSelection;
  service.saveSelection = function (next) {
    return next?.provider === PROVIDER ? Promise.resolve() : save.call(this, next);
  };
  ctx.effect(() => () => { service.saveSelection = save; }, "layerfs-mock: default model kept");
}
