# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Start Expo development server
npm start

# Run on specific platforms
npm run android    # Start Android emulator/device
npm run ios        # Start iOS simulator/device
npm run web        # Start web development server
```

## Architecture

This is an Expo SDK 54 React Native application with the new architecture enabled (`newArchEnabled: true`).

**Entry Point**: `index.ts` registers the root component via Expo's `registerRootComponent`

**Main Component**: `App.tsx` is the root React component

**Key Dependencies**:
- `@supabase/supabase-js` - Backend integration with Supabase
- `expo-camera` - Camera access
- `expo-image-picker` - Image selection from gallery

**Configuration**:
- `app.json` - Expo app configuration (icons, splash screen, platform settings)
- `tsconfig.json` - TypeScript with strict mode, extends Expo's base config
