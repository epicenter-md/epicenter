# Canary TypeScript Integration Analysis Report

**Date**: 2026-01-11
**Project**: Whisper Wing Canary
**Analyst**: Code Quality Analyzer

## Summary

**Overall Quality Score**: 6/10
**Files Analyzed**: 6
**Critical Issues Found**: 4
**Missing Integration Points**: 3
**Technical Debt Estimate**: 3-4 hours

The Canary service implementation is **partially integrated** but has several critical missing pieces that prevent it from functioning. While the core service file (`canary.ts`) is well-structured and follows the same patterns as other local engines, the integration into the application's transcription dispatch system is **incomplete**.

---

## ✅ What's Correct

### 1. **canary.ts Service Implementation** ✓
**File**: `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/services/isomorphic/transcription/local/canary.ts`

**Strengths**:
- ✅ Correctly calls Tauri command `transcribe_audio_canary` (line 170)
- ✅ Model download URLs are valid (HuggingFace: `istupakov/canary-1b-v2-onnx`)
- ✅ File structure is consistent with `parakeet.ts` (directory-based, multiple ONNX files)
- ✅ Error handling is comprehensive and matches other engines
- ✅ Language support correctly implemented with `language` parameter (line 173)
- ✅ All 5 model files properly defined (encoder, decoder, vocab, config, nemo128)
- ✅ Pre-validation checks (directory existence, type validation)
- ✅ Arktype error validation pattern matches other services

### 2. **registry.ts Service Definition** ✓
**File**: `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/services/isomorphic/transcription/registry.ts`

**Strengths**:
- ✅ 'canary' properly added to `TRANSCRIPTION_SERVICE_IDS` (line 42)
- ✅ Service definition is correct (lines 112-119):
  - `id: 'canary'`
  - `name: 'Canary'`
  - `icon: nvidiaIcon`
  - `description: 'NVIDIA NeMo model with language support'`
  - `modelPathField: 'transcription.canary.modelPath'`
  - `location: 'local'`
- ✅ Capabilities correctly defined (lines 275-279):
  - `supportsPrompt: false` ✓
  - `supportsTemperature: false` ✓
  - `supportsLanguage: true` ✓ (KEY FEATURE)

### 3. **types.ts Definition** ✓
**File**: `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/services/isomorphic/transcription/local/types.ts`

**Strengths**:
- ✅ `CanaryModelConfig` properly defined (lines 137-150)
- ✅ Includes `files` array with correct structure
- ✅ Included in `LocalModelConfig` union type (line 159)
- ✅ Follows same pattern as `ParakeetModelConfig`

---

## 🚨 Critical Issues

### **Issue #1: Missing Service Export** (HIGH SEVERITY)
**File**: `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/services/isomorphic/transcription/index.ts`
**Lines**: 1-28

**Problem**:
The `CanaryTranscriptionServiceLive` is **NOT imported or exported** from the main transcription service index.

**Current State**:
```typescript
// Local transcription services
import { MoonshineTranscriptionServiceLive } from './local/moonshine';
import { ParakeetTranscriptionServiceLive } from './local/parakeet';
import { WhisperCppTranscriptionServiceLive } from './local/whispercpp';
// ❌ MISSING: import { CanaryTranscriptionServiceLive } from './local/canary';

export {
	WhisperCppTranscriptionServiceLive as whispercpp,
	ParakeetTranscriptionServiceLive as parakeet,
	MoonshineTranscriptionServiceLive as moonshine,
	// ❌ MISSING: CanaryTranscriptionServiceLive as canary,
	...
};
```

**Impact**: The canary service cannot be called from anywhere in the application.

**Fix Required**:
```typescript
import { CanaryTranscriptionServiceLive } from './local/canary';

export {
	WhisperCppTranscriptionServiceLive as whispercpp,
	ParakeetTranscriptionServiceLive as parakeet,
	CanaryTranscriptionServiceLive as canary,  // ADD THIS
	MoonshineTranscriptionServiceLive as moonshine,
	...
};
```

---

### **Issue #2: Missing Dispatch Case** (HIGH SEVERITY)
**File**: `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/query/isomorphic/transcription.ts`
**Lines**: 178-284 (switch statement in `transcribeBlob` function)

**Problem**:
The `canary` service has **NO case** in the transcription dispatch switch statement.

**Current State**:
```typescript
switch (selectedService) {
	case 'OpenAI': ...
	case 'Groq': ...
	case 'whispercpp': ...
	case 'parakeet': ...
	case 'moonshine': ...
	// ❌ MISSING: case 'canary': ...
	default:
		return WhisperingErr({
			title: '⚠️ No transcription service selected',
			description: 'Please select a transcription service in settings.',
		});
}
```

**Impact**: When user selects Canary service, it will fall through to the default case and show "No transcription service selected" error.

**Fix Required**:
```typescript
case 'canary': {
	// Canary supports language selection!
	return await services.transcriptions.canary.transcribe(
		audioToTranscribe,
		{
			modelPath: settings.value['transcription.canary.modelPath'],
			language: settings.value['transcription.outputLanguage'] === 'auto'
				? 'fr' // Default to French if auto-detect
				: settings.value['transcription.outputLanguage'],
		},
	);
}
```

**Location**: Insert after the `parakeet` case (after line 268) and before `moonshine` case.

---

### **Issue #3: Missing Settings Definition** (MEDIUM SEVERITY)
**File**: `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/settings/settings.ts`
**Lines**: 203-205

**Problem**:
The `transcription.canary.modelPath` setting is **referenced in registry.ts** but **not defined in the settings schema**.

**Current State**:
```typescript
'transcription.whispercpp.modelPath': "string = ''",
'transcription.parakeet.modelPath': "string = ''",
'transcription.moonshine.modelPath': "string = ''",
// ❌ MISSING: 'transcription.canary.modelPath': "string = ''",
```

**Impact**:
- TypeScript compilation may fail
- Settings cannot be saved/loaded
- UI components cannot bind to this setting

**Fix Required**:
```typescript
'transcription.whispercpp.modelPath': "string = ''",
'transcription.parakeet.modelPath': "string = ''",
'transcription.canary.modelPath': "string = ''",  // ADD THIS
'transcription.moonshine.modelPath': "string = ''",
```

**Location**: Insert after line 204 (`transcription.parakeet.modelPath`).

---

### **Issue #4: Missing Model Download Support** (LOW SEVERITY)
**File**: `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/components/settings/LocalModelDownloadCard.svelte`

**Problem**:
The component that handles model downloads does **NOT import or expose** `CANARY_MODELS`.

**Impact**: Users cannot download Canary models from the UI.

**Investigation Needed**:
- Check if component has a generic model loader that would pick up canary automatically
- Verify if `CANARY_MODELS` needs to be explicitly imported
- Test if the model selector UI shows canary option

---

## 📋 Missing Integration Checklist

Based on the analysis, here are the **required changes** to make Canary fully functional:

### **High Priority** (Blocking functionality)
- [ ] **Add Canary import to** `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/services/isomorphic/transcription/index.ts`
- [ ] **Add Canary export to** `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/services/isomorphic/transcription/index.ts`
- [ ] **Add case 'canary' to** `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/query/isomorphic/transcription.ts`
- [ ] **Add 'transcription.canary.modelPath' to** `/home/debian/projects/whisper-wing-canary/apps/whispering/src/lib/settings/settings.ts`

### **Medium Priority** (UI/UX)
- [ ] **Verify model download UI supports Canary** in `LocalModelDownloadCard.svelte`
- [ ] **Verify model selector UI shows Canary** in `LocalModelSelector.svelte`
- [ ] **Test language selector appears** when Canary is selected (should be automatic via `supportsLanguage: true`)

### **Low Priority** (Documentation)
- [ ] Add Canary to README/documentation
- [ ] Add example usage instructions
- [ ] Document language support capabilities

---

## 🔍 Code Quality Observations

### **Positive Findings**:
1. **Excellent consistency**: `canary.ts` follows exact same patterns as `parakeet.ts` and `moonshine.ts`
2. **Proper error handling**: All error cases are covered with user-friendly messages
3. **Good type safety**: Uses Arktype for runtime validation
4. **Clear documentation**: Comments explain key features (language support, model files)
5. **Correct model URLs**: HuggingFace URLs are valid and files exist

### **Code Smells**:
1. **Incomplete integration**: Service implemented but not wired up (common pattern when adding new features incrementally)
2. **No tests found**: No test files for canary service detected
3. **Duplicate icon**: Uses `nvidiaIcon` (same as parakeet) - consider a unique icon

### **Best Practices Observed**:
- ✅ Proper separation of concerns (service layer, UI layer, types)
- ✅ Consistent error handling patterns
- ✅ Type-safe configuration
- ✅ Clear naming conventions

---

## 🛠️ Recommended Fix Implementation Order

**Step 1**: Add settings definition (safest, no dependencies)
```typescript
// In settings.ts line 205
'transcription.canary.modelPath': "string = ''",
```

**Step 2**: Export canary service (enables imports)
```typescript
// In index.ts
import { CanaryTranscriptionServiceLive } from './local/canary';
export { CanaryTranscriptionServiceLive as canary };
```

**Step 3**: Add dispatch case (enables functionality)
```typescript
// In transcription.ts after line 268
case 'canary': {
	return await services.transcriptions.canary.transcribe(
		audioToTranscribe,
		{
			modelPath: settings.value['transcription.canary.modelPath'],
			language: settings.value['transcription.outputLanguage'] === 'auto'
				? 'fr'
				: settings.value['transcription.outputLanguage'],
		},
	);
}
```

**Step 4**: Test and verify
- Run TypeScript compiler
- Test model download UI
- Test transcription with Canary service
- Verify language selector works

---

## 📊 Technical Debt Summary

| Category | Item | Estimated Time |
|----------|------|----------------|
| **Critical** | Add service export | 5 minutes |
| **Critical** | Add dispatch case | 15 minutes |
| **Critical** | Add settings definition | 5 minutes |
| **Testing** | Write unit tests | 1-2 hours |
| **Testing** | Integration testing | 30 minutes |
| **UI Verification** | Check model download UI | 15 minutes |
| **Documentation** | Update README/docs | 30 minutes |
| **Total** | | **3-4 hours** |

---

## 🎯 Conclusion

The Canary service implementation is **well-written and follows best practices**, but the integration is **incomplete**. This appears to be a work-in-progress where the service was implemented but not yet connected to the application's dispatch system.

**All critical issues can be fixed with ~25 minutes of focused development work**, plus additional time for testing and verification.

**Recommendation**: Prioritize the 3 high-priority fixes to make the feature functional, then allocate time for comprehensive testing.

---

## 📝 Notes

- **Language Support**: Canary's key differentiator (25 language support) is properly implemented but untested
- **Model Files**: All 5 ONNX files are correctly defined and URLs are valid
- **Error Messages**: User-friendly error messages with actionable next steps
- **Consistency**: Implementation matches existing patterns perfectly

**Next Steps**: Implement the 3 critical fixes, then verify end-to-end functionality with a test recording.
