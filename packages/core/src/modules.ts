/**
 * The in-process modules this deployment ships. Order is only for deterministic
 * logging; modules must not depend on each other's tools. Narrow the set at
 * runtime with FRIDAY_MODULES=<id>,<id>.
 */
import type { FridayModule } from "@friday/sdk";
import builtin from "@friday/module-builtin";
import media from "@friday/module-media";
import brain from "@friday/module-brain";
import travel from "@friday/module-travel";

export const modules: FridayModule[] = [builtin, media, brain, travel];
