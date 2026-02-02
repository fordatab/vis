// Mock expo-image-picker
jest.mock('expo-image-picker', () => ({
  launchCameraAsync: jest.fn(),
  MediaTypeOptions: {
    Images: 'Images',
  },
}));

// Mock supabase client
jest.mock('./lib/supabase', () => ({
  supabase: {
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn().mockResolvedValue({ data: {}, error: null }),
        getPublicUrl: jest.fn(() => ({
          data: { publicUrl: 'https://example.com/test.jpg' },
        })),
      })),
    },
    from: jest.fn(() => ({
      insert: jest.fn().mockResolvedValue({ data: {}, error: null }),
    })),
    functions: {
      invoke: jest.fn().mockResolvedValue({
        data: { answer: 'Test answer', image: null },
        error: null,
      }),
    },
  },
}));
