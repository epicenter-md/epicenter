/**
 * Measurement-method validation. Fail-closed by construction.
 *
 * Policy (ADR-0161; spec 424-444, 555-562): evidence never selects, ranks,
 * recommends, applies a tie-break, or returns a candidate id. There is no
 * recommendation, winner, or tie-break concept anywhere in this module.
 * `validateMethod` gives a run its method-validation verdict: whether every
 *    measurement-method proof gate, DERIVED FROM RECORDED OPERATIONS by the
 *    runner, passed. A gate is never a hardcoded boolean; the runner must feed
 *    evidence it actually executed and retained. A pilot validates the METHOD
 *    only; it is never ADR-ready.
 *
 * Final-evidence readiness and absolute SLO policy are deliberately absent. No
 * product policy owns those concepts yet, so this pilot reports only the method
 * facts it can establish and never predicts a future ADR-readiness contract.
 *
 * Correctness note (spec/audit): a candidate reproducing the analytical, V1-bound
 * oracle witness is the INDEPENDENT correctness proof. When every candidate
 * reproduces that witness, mutual consistency follows by equality and does not
 * earn a duplicate gate. Reopen consistency remains a separate observation.
 */

export type GateStatus = {
	name: string;
	passed: boolean;
	detail: string;
};

export type ProofGateInputs = {
	/** INDEPENDENT correctness: every cell reproduced the analytical V1-bound oracle witness. */
	oracleWitnessReproduced: boolean;
	/** Every retained trace hit its declared logical-state target within the fact ceiling. */
	traceAdmissible: boolean;
	/** Every retained trace admitted under the private V1 kernel and byte oracle. */
	traceV1Bound: boolean;
	/** Every retained auxiliary V1-shaped record admitted under the private kernel. */
	auxiliaryV1Bound: boolean;
	/** The run's source and config identity match the persisted checkpoint. */
	provenanceMatches: boolean;
	/** Every identity-closed seed estimator exactly matches retained raw observations. */
	estimatorsComplete: boolean;
	/** Every seed is closed, count-exact, schedule-balanced, and complete for every owner workload. */
	seedEvidenceComplete: boolean;
	/** Every RECORDED timed block met the 20 ms floor at the frozen operation count. */
	calibrationMet: boolean;
	/** Untimed warmup batches ran immediately before each recorded timed block. */
	warmupsRun: boolean;
	/** SQLite integrity_check passed and each candidate's recorded reopened self-hash matched. */
	integrityOk: boolean;
	/** At least the required balanced close/open reopen observations were recorded per cell. */
	reopenObservationsSufficient: boolean;
	/** Every mutating tail started from a recorded byte-equivalent deterministic reset. */
	deterministicResetProven: boolean;
	/** The headroom preflight passed BEFORE retaining the envelope databases, with a 25% margin. */
	headroomPreflightPassed: boolean;
	/**
	 * The run's dimensions match the frozen exact-envelope pilot: exactly 1,000,000
	 * final-present addresses, exactly 536,870,912 proxy bytes, four fresh seeds,
	 * three complete Williams cycles, exactly twenty reopens, and exactly 400 tail
	 * transactions. A bounded smoke fails this and can never be method-validated.
	 */
	exactEnvelopeConformant: boolean;
	/**
	 * The checkpoint-boundary observation is a truthful, non-perturbing signal
	 * grounded in SQLite behavior. If no such signal is available the runner records
	 * the limitation and fails this gate rather than fabricating boundaries.
	 */
	checkpointBoundariesTruthful: boolean;
};

export type MethodValidation = {
	/** True only when every measurement-method proof gate passed. */
	methodValidated: boolean;
	gates: GateStatus[];
	/** Failed-gate reasons, empty exactly when `methodValidated`. */
	proofRefusals: string[];
};

/** The ordered proof gates. Adding a gate here adds it to the conjunction. */
function gatesOf(inputs: ProofGateInputs): GateStatus[] {
	return [
		{
			name: 'oracle-correctness',
			passed: inputs.oracleWitnessReproduced,
			detail:
				'every cell reproduced the analytical V1-bound oracle witness (independent correctness)',
		},
		{
			name: 'trace-admissible',
			passed: inputs.traceAdmissible,
			detail:
				'every retained seed trace hit its logical-state target within the fact ceiling',
		},
		{
			name: 'trace-v1-binding',
			passed: inputs.traceV1Bound,
			detail:
				'every retained seed trace admitted and byte-agreed with the V1 kernel',
		},
		{
			name: 'auxiliary-v1-binding',
			passed: inputs.auxiliaryV1Bound,
			detail:
				'every retained auxiliary V1-shaped record admitted under the V1 kernel',
		},
		{
			name: 'provenance',
			passed: inputs.provenanceMatches,
			detail: 'run source and config identity match the persisted checkpoint',
		},
		{
			name: 'seed-estimators',
			passed: inputs.estimatorsComplete,
			detail:
				'every identity-closed seed estimator exactly matches retained raw observations',
		},
		{
			name: 'seed-evidence-complete',
			passed: inputs.seedEvidenceComplete,
			detail:
				'every retained seed is closed, count-exact, schedule-balanced, and complete for every declared owner workload',
		},
		{
			name: 'calibration',
			passed: inputs.calibrationMet && inputs.warmupsRun,
			detail:
				'every recorded timed block met the 20 ms floor after an immediate untimed warmup',
		},
		{
			name: 'integrity',
			passed: inputs.integrityOk,
			detail:
				'SQLite integrity_check passed and each recorded reopened self-hash matched',
		},
		{
			name: 'reopen',
			passed: inputs.reopenObservationsSufficient,
			detail: 'the required balanced reopen observations were recorded',
		},
		{
			name: 'deterministic-reset',
			passed: inputs.deterministicResetProven,
			detail:
				'every mutating tail began from a recorded byte-equivalent deterministic reset',
		},
		{
			name: 'headroom',
			passed: inputs.headroomPreflightPassed,
			detail:
				'the headroom preflight passed before retaining the envelope databases',
		},
		{
			name: 'exact-envelope',
			passed: inputs.exactEnvelopeConformant,
			detail:
				'the run matches the frozen exact-envelope pilot (1,000,000 present addresses, 512 MiB proxy, four seeds, three cycles); a smoke can never pass this',
		},
		{
			name: 'checkpoint-truthful',
			passed: inputs.checkpointBoundariesTruthful,
			detail:
				'the checkpoint-boundary signal is truthful and non-perturbing, grounded in SQLite behavior',
		},
	];
}

export function validateMethod(inputs: ProofGateInputs): MethodValidation {
	const gates = gatesOf(inputs);
	const failed = gates.filter((gate) => !gate.passed);
	return {
		methodValidated: failed.length === 0,
		gates,
		proofRefusals: failed.map((gate) => `${gate.name}: ${gate.detail}`),
	};
}
