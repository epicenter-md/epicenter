# Add Infinite Toast Duration Support

## Overview
Add support for infinite/persistent toasts that remain visible until manually dismissed. This will be implemented using a boolean `persist` flag rather than duration-based approach.

## Design Decision
Using a boolean `persist` flag instead of numeric duration values like `Infinity` or `-1` because:
1. More explicit and self-documenting
2. Cleaner API that clearly indicates intent
3. Avoids potential issues with special numeric values
4. Easier to extend in the future if needed

## Todo Items

- [ ] Add `persist` property to `UnifiedNotificationOptions` type
  - Add as optional boolean property
  - Add JSDoc explaining it only applies to toast notifications (Sonner)
  - Document that persistent toasts stay until manually dismissed

- [ ] Update `getDuration` function in `toast.ts`
  - Check for `persist` flag first, return `Infinity` if true
  - Keep existing duration logic as fallback

- [ ] Test the implementation
  - Create a test toast with persist: true
  - Verify it stays indefinitely
  - Verify it can be dismissed manually
  - Test that non-persistent toasts still auto-dismiss

- [ ] Consider edge cases
  - What happens with loading toasts that persist?
  - Should error/warning toasts default to persist in some cases?
  - Document any limitations or best practices

## Implementation Details

### Type Changes
```typescript
// In types.ts
export type UnifiedNotificationOptions = {
  // ... existing properties ...
  
  /**
   * Keep toast visible indefinitely until manually dismissed
   * @toast Uses Infinity duration in Sonner
   * @note Only applies to toast notifications, not OS notifications
   */
  persist?: boolean;
}
```

### Toast Service Changes
```typescript
// In toast.ts
function getDuration(options: UnifiedNotificationOptions): number {
  // Persistent toasts use Infinity duration
  if (options.persist) return Infinity;
  
  // Existing duration logic
  if (options.variant === 'loading') return 5000;
  if (options.variant === 'error' || options.variant === 'warning') return 5000;
  if (options.action) return 4000;
  return 3000;
}
```

## Usage Example
```typescript
// Show a persistent error that requires user acknowledgment
ToastService.show({
  variant: 'error',
  title: 'Critical Error',
  description: 'This requires your attention',
  persist: true,
  action: {
    type: 'button',
    label: 'Acknowledge',
    onClick: () => ToastService.dismiss()
  }
});
```

## Notes
- The `persist` flag only affects toast notifications (Sonner implementation)
- OS notifications have their own `requireInteraction` flag which serves a similar purpose
- Consider adding this to documentation/examples for common use cases

## Review

### Changes Made
1. **Added `persist` property to `UnifiedNotificationOptions`** in `types.ts`
   - Added as optional boolean property
   - Included comprehensive JSDoc explaining it only applies to Sonner toasts
   - Positioned after the `variant` property for logical grouping

2. **Updated `getDuration` function** in `toast.ts`
   - Added check for `persist` flag at the beginning of the function
   - Returns `Infinity` when `persist` is true
   - Maintains all existing duration logic for non-persistent toasts

3. **Created test page** at `/test-persist-toast`
   - Demonstrates persistent error toast with dismiss action
   - Shows comparison with normal auto-dismissing toast
   - Includes persistent loading toast example
   - Provides manual dismiss button for testing

### Implementation Notes
- The implementation is minimal and focused, following the simplicity principle
- No breaking changes - the feature is entirely opt-in
- The `persist` flag integrates seamlessly with existing toast variants and actions
- Sonner handles `Infinity` duration correctly, keeping the toast visible indefinitely

### Test Instructions
1. Navigate to `/test-persist-toast` in the app
2. Click "Show Persistent Error" - toast should stay visible
3. Click "Show Normal Toast" - should auto-dismiss after 3 seconds
4. Test the dismiss action button within the persistent toast
5. Test the external dismiss button for persistent toasts

The feature is ready for use and can be applied to critical notifications that require user acknowledgment.