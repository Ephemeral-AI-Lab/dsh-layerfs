/**
 * The preset runner and recipe are LayerFS Connect's JavaScript, kept as close
 * to the source as the port allows so they stay diffable against it. This
 * module is their typed seam for the TypeScript side: everything is `any`.
 */
import * as build from './build.js'
import * as reset from './environment-reset.js'
import * as stop from './machine-stop.js'
import * as runner from './runner.js'
import * as mixed from './recipe/mixed-recipe.js'
import * as presetsJs from './recipe/presets.js'
import * as projects from './recipe/projects.js'
import * as recipe from './recipe/recipe.js'
import * as page from './recipe/script-page.js'
import * as journal from './recipe/step-journal.js'

const js = (m: unknown): any => m

export const { buildPreset, prepareBuild, presetScript } = js(build)
export const { EnvironmentReset, liveReceipt } = js(reset)
export const { MachineStop } = js(stop)
export const { TOOL } = js(runner)
export const { MIXED_RECIPE_VERSION } = js(mixed)
export const { CONTENT_VERSION, presetOf, presets } = js(presetsJs)
export const { projectDefinition } = js(projects)
export const { projectHistoryPlan } = js(recipe)
export const { scriptPage } = js(page)
export const { StepJournal } = js(journal)
