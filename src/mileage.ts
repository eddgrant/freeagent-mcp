// Mileage-claim handling for the expense tools.
//
// A FreeAgent mileage claim is an expense with category "Mileage" and a
// different field set: mileage, vehicle_type, and — for cars and
// motorcycles — engine_type + engine_size. The valid engine types and
// sizes change over time (HMRC revisions), so they are validated against
// GET /expenses/mileage_settings for the claim date.
//
// Tool input shape is validated by the Zod schema in tool-schemas.ts;
// this module holds the date-scoped engine resolution and payload build.
// Defensive by design: if the mileage_settings response can't be parsed
// into a date-scoped engine map, engine resolution degrades to passing
// the caller's values through — a docs-shape guess should never block a
// legitimate claim.

import { z } from 'zod';
import type { ExpenseCreatePayload, ExpenseAttachmentPayload, MileageSettings } from './types.js';
import { toolSchemas } from './tool-schemas.js';

export type VehicleType = 'Car' | 'Motorcycle' | 'Bicycle';

/** Validated create_mileage_expense input (the Zod-inferred shape). */
export type CreateMileageExpenseInput = z.infer<typeof toolSchemas.create_mileage_expense>;

export interface ResolvedEngine {
    engine_type?: string;
    engine_size?: string;
}

/** Vehicle types that carry an engine_type/engine_size. */
function hasEngine(v: VehicleType): boolean {
    return v === 'Car' || v === 'Motorcycle';
}

function dateInPeriod(dated_on: string, from?: string, to?: string | null): boolean {
    if (from && dated_on < from) return false;
    if (to && dated_on > to) return false;
    return true;
}

/** Find the engine type → sizes map covering `dated_on`, or null if the
 *  settings can't be parsed into one. */
export function findEngineOptionsForDate(
    settings: MileageSettings,
    dated_on: string,
): Record<string, string[]> | null {
    const periods = settings.engine_type_and_size_options;
    if (!Array.isArray(periods)) return null;
    const covering = periods.find(p => dateInPeriod(dated_on, p.from, p.to));
    const value = covering?.value;
    if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return null;
    return value;
}

/** Validate and resolve the engine type/size for a mileage claim, with
 *  helpful, option-listing errors. `options` is null when the settings
 *  couldn't be parsed — in that case the caller's values pass through. */
export function resolveEngine(
    options: Record<string, string[]> | null,
    input: { vehicle_type: VehicleType; engine_type?: string; engine_size?: string; dated_on: string },
): ResolvedEngine {
    if (!hasEngine(input.vehicle_type)) return {};

    if (!options) {
        if (!input.engine_size) {
            throw new Error(
                `engine_size is required for a ${input.vehicle_type} mileage claim. ` +
                `Call get_mileage_settings to see the valid engine types and sizes.`,
            );
        }
        return { engine_type: input.engine_type ?? 'Petrol', engine_size: input.engine_size };
    }

    const typeKeys = Object.keys(options);
    let engineType: string;
    if (input.engine_type) {
        const match = typeKeys.find(k => k.toLowerCase() === input.engine_type!.toLowerCase());
        if (!match) {
            throw new Error(
                `engine_type "${input.engine_type}" is not valid for ${input.dated_on}. ` +
                `Valid engine types: ${typeKeys.join(', ')}.`,
            );
        }
        engineType = match;
    } else {
        const petrol = typeKeys.find(k => k.toLowerCase() === 'petrol');
        if (!petrol) {
            throw new Error(
                `engine_type is required for a ${input.vehicle_type}. ` +
                `Valid engine types for ${input.dated_on}: ${typeKeys.join(', ')}.`,
            );
        }
        engineType = petrol;
    }

    const sizes = options[engineType] ?? [];
    if (!input.engine_size) {
        throw new Error(
            `engine_size is required for a ${engineType} ${input.vehicle_type}. ` +
            `Valid sizes: ${sizes.join(', ')}.`,
        );
    }
    const sizeMatch = sizes.find(s => s.toLowerCase() === input.engine_size!.toLowerCase());
    if (!sizeMatch) {
        throw new Error(
            `engine_size "${input.engine_size}" is not valid for a ${engineType} ${input.vehicle_type}. ` +
            `Valid sizes: ${sizes.join(', ')}.`,
        );
    }
    return { engine_type: engineType, engine_size: sizeMatch };
}

/** Build the FreeAgent wire payload for a mileage claim. */
export function buildMileagePayload(
    input: CreateMileageExpenseInput,
    refs: { user: string; engine: ResolvedEngine; attachment?: ExpenseAttachmentPayload },
): ExpenseCreatePayload {
    const payload: ExpenseCreatePayload = {
        user: refs.user,
        dated_on: input.dated_on,
        category: 'Mileage',
        mileage: String(input.mileage),
        vehicle_type: input.vehicle_type,
        // Default: reclaim at the AMAP rate unless explicitly disabled.
        reclaim_mileage: input.reclaim_mileage === false ? 0 : 1,
    };
    if (refs.engine.engine_type) payload.engine_type = refs.engine.engine_type;
    if (refs.engine.engine_size) payload.engine_size = refs.engine.engine_size;
    if (input.description) payload.description = input.description;
    if (input.receipt_reference) payload.receipt_reference = input.receipt_reference;
    if (input.have_vat_receipt !== undefined) payload.have_vat_receipt = input.have_vat_receipt;
    if (refs.attachment) payload.attachment = refs.attachment;
    return payload;
}
