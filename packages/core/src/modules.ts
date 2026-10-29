/**
 * The in-process modules this deployment ships. Order is only for deterministic
 * logging; modules must not depend on each other's tools. An admin turns each
 * one on or off under System > Modules (stored in friday.db; on by default).
 */
import type { FridayModule } from "@friday/sdk";
import builtin from "@friday/module-builtin";
import media from "@friday/module-media";
import brain from "@friday/module-brain";
import travel from "@friday/module-travel";
import spotify from "@friday/module-spotify";
import calendar from "@friday/module-calendar";
import sonos from "@friday/module-sonos";

export const modules: FridayModule[] = [builtin, media, brain, travel, spotify, calendar, sonos];
