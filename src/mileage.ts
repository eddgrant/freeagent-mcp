// Mileage-claim handling for the expense tools.
//
// A FreeAgent mileage claim is an expense with category "Mileage" and a
// different field set: mileage, vehicle_type, and — for cars and
// motorcycles — engine_type + engine_size. The valid engine types and
// sizes change over time (HMRC revisions), so they are validated against
// GET /expenses/mileage_settings for the claim date.
//
// Defensive by design: if the mileage_settings response can't be parsed
// into a date-scoped engine map, validation degrades to passing the
// caller's engine_type/engine_size through and letting FreeAgent be the
// authority — a docs-shape guess should never block a legitimate claim.

import type { ExpenseCreatePayload, ExpenseAttachmentPayload, MileageSettings } from './types.js';
import type { ExpenseAttachmentInput } from './expenses.js';

export const VEHICLE_TYPES = ['Car', 'Motorcycle', 'Bicycle'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** Vehicle types that carry an engine_type/engine_size. */
function hasEngine(v: VehicleType): boolean {
    return v === 'Car' || v === 'Motorcycle';
}

export interface CreateMileageExpenseInput {
    user?: string;
    dated_on: string;
    mileage: string;            // positive magnitude
    vehicle_type: VehicleType;
    engine_type?: string;
    engine_size?: string;
    reclaim_mileage: boolean;   // true ⇒ claim at the AMAP rate (the default)
    description?: string;
    receipt_reference?: string;
    have_vat_receipt?: boolean;
    attachment?: ExpenseAttachmentInput;
}

export interface ResolvedEngine {
    engine_type?: string;
    engine_size?: string;
}

function normalisePositiveAmount(value: unknown, label: string): string {
    let n: number;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
    else throw new Error(`${label} is required and must be a positive number`);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number, got ${JSON.stringify(value)}`);
    if (n <= 0) throw new Error(`${label} must be a positive number of miles`);
    return String(value).trim();
}

function validateVehicleType(value: unknown): VehicleType {
    if (typeof value === 'string') {
        const match = VEHICLE_TYPES.find(v => v.toLowerCase() === value.trim().toLowerCase());
        if (match) return match;
    }
    throw new Error(`vehicle_type is required and must be one of ${VEHICLE_TYPES.join(', ')}`);
}

function validateAttachmentInput(value: unknown): ExpenseAttachmentInput {
    if (typeof value !== 'object' || value == null) throw new Error('attachment must be an object');
    const a = value as Record<string, unknown>;
    if (typeof a.evidence_path !== 'string' || a.evidence_path.trim() === '') {
        throw new Error('attachment.evidence_path is required (a path returned by stage_evidence)');
    }
    if (typeof a.file_name !== 'string' || a.file_name.trim() === '') {
        throw new Error('attachment.file_name is required');
    }
    if (typeof a.content_type !== 'string' || a.content_type.trim() === '') {
        throw new Error('attachment.content_type is required');
    }
    const out: ExpenseAttachmentInput = {
        evidence_path: a.evidence_path,
        file_name: a.file_name,
        content_type: a.content_type,
    };
    if (typeof a.description === 'string') out.description = a.description;
    return out;
}

export function validateCreateMileageExpenseInput(data: unknown): CreateMileageExpenseInput {
    if (typeof data !== 'object' || data == null) {
        throw new Error('Invalid mileage expense data: must be an object');
    }
    const a = data as Record<string, unknown>;

    if (typeof a.dated_on !== 'string' || a.dated_on.trim() === '') {
        throw new Error('dated_on is required (YYYY-MM-DD)');
    }
    const vehicle_type = validateVehicleType(a.vehicle_type);

    const input: CreateMileageExpenseInput = {
        dated_on: a.dated_on.trim(),
        mileage: normalisePositiveAmount(a.mileage, 'mileage'),
        vehicle_type,
        // Default: reclaim at the AMAP rate unless explicitly disabled.
        reclaim_mileage: a.reclaim_mileage !== false,
    };
    if (typeof a.user === 'string' && a.user.trim() !== '') input.user = a.user.trim();
    if (typeof a.engine_type === 'string' && a.engine_type.trim() !== '') input.engine_type = a.engine_type.trim();
    if (typeof a.engine_size === 'string' && a.engine_size.trim() !== '') input.engine_size = a.engine_size.trim();
    if (typeof a.description === 'string') input.description = a.description;
    if (typeof a.receipt_reference === 'string') input.receipt_reference = a.receipt_reference;
    if (typeof a.have_vat_receipt === 'boolean') input.have_vat_receipt = a.have_vat_receipt;
    if (a.attachment !== undefined) input.attachment = validateAttachmentInput(a.attachment);
    return input;
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
        mileage: input.mileage,
        vehicle_type: input.vehicle_type,
        reclaim_mileage: input.reclaim_mileage ? 1 : 0,
    };
    if (refs.engine.engine_type) payload.engine_type = refs.engine.engine_type;
    if (refs.engine.engine_size) payload.engine_size = refs.engine.engine_size;
    if (input.description) payload.description = input.description;
    if (input.receipt_reference) payload.receipt_reference = input.receipt_reference;
    if (input.have_vat_receipt !== undefined) payload.have_vat_receipt = input.have_vat_receipt;
    if (refs.attachment) payload.attachment = refs.attachment;
    return payload;
}
