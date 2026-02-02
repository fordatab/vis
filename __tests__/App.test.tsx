import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { Alert, Keyboard } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import App from '../App';
import { supabase } from '../lib/supabase';

// Button text includes emojis
const CAPTURE_BUTTON = /Capture/;
const SEARCH_BUTTON = /Search/;

// Spy on Alert and Keyboard
jest.spyOn(Alert, 'alert').mockImplementation(() => {});
jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});

describe('App', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Initial render', () => {
    it('renders capture mode by default', () => {
      render(<App />);

      expect(screen.getByText('Visual Memory')).toBeOnTheScreen();
      expect(screen.getByText('Snap photos of your stuff.')).toBeOnTheScreen();
      expect(screen.getByText('Take Photo')).toBeOnTheScreen();
    });

    it('renders navigation buttons', () => {
      render(<App />);

      expect(screen.getByText(CAPTURE_BUTTON)).toBeOnTheScreen();
      expect(screen.getByText(SEARCH_BUTTON)).toBeOnTheScreen();
    });
  });

  describe('Mode switching', () => {
    it('switches to search mode when Search button is pressed', () => {
      render(<App />);

      fireEvent.press(screen.getByText(SEARCH_BUTTON));

      expect(screen.getByText('Ask Recall')).toBeOnTheScreen();
      expect(screen.getByPlaceholderText('e.g., Where are my keys?')).toBeOnTheScreen();
      expect(screen.getByText('Ask AI')).toBeOnTheScreen();
    });

    it('switches back to capture mode when Capture button is pressed', () => {
      render(<App />);

      fireEvent.press(screen.getByText(SEARCH_BUTTON));
      fireEvent.press(screen.getByText(CAPTURE_BUTTON));

      expect(screen.getByText('Visual Memory')).toBeOnTheScreen();
      expect(screen.getByText('Take Photo')).toBeOnTheScreen();
    });
  });

  describe('Capture functionality', () => {
    it('calls ImagePicker when Take Photo is pressed', async () => {
      const mockLaunchCamera = ImagePicker.launchCameraAsync as jest.Mock;
      mockLaunchCamera.mockResolvedValue({ canceled: true });

      render(<App />);
      fireEvent.press(screen.getByText('Take Photo'));

      await waitFor(() => {
        expect(mockLaunchCamera).toHaveBeenCalledWith({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: false,
          quality: 0.5,
          base64: true,
        });
      });
    });

    it('uploads image when photo is taken successfully', async () => {
      const mockLaunchCamera = ImagePicker.launchCameraAsync as jest.Mock;
      mockLaunchCamera.mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file://test.jpg', base64: 'base64data' }],
      });

      const mockStorageFrom = supabase.storage.from as jest.Mock;

      render(<App />);
      fireEvent.press(screen.getByText('Take Photo'));

      await waitFor(() => {
        expect(mockStorageFrom).toHaveBeenCalledWith('images');
      });
    });
  });

  describe('Search functionality', () => {
    it('allows typing in search input', () => {
      render(<App />);
      fireEvent.press(screen.getByText(SEARCH_BUTTON));

      const input = screen.getByPlaceholderText('e.g., Where are my keys?');
      fireEvent.changeText(input, 'Where is my wallet?');

      expect(input.props.value).toBe('Where is my wallet?');
    });

    it('calls supabase function when search is submitted', async () => {
      const mockInvoke = supabase.functions.invoke as jest.Mock;
      mockInvoke.mockResolvedValue({
        data: { answer: 'Your wallet is on the table', image: null },
        error: null,
      });

      render(<App />);
      fireEvent.press(screen.getByText(SEARCH_BUTTON));

      const input = screen.getByPlaceholderText('e.g., Where are my keys?');
      fireEvent.changeText(input, 'Where is my wallet?');
      fireEvent.press(screen.getByText('Ask AI'));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('search-items', {
          body: { query: 'Where is my wallet?' },
        });
      });
    });

    it('displays search results', async () => {
      const mockInvoke = supabase.functions.invoke as jest.Mock;
      mockInvoke.mockResolvedValue({
        data: { answer: 'Your wallet is on the kitchen table', image: null },
        error: null,
      });

      render(<App />);
      fireEvent.press(screen.getByText(SEARCH_BUTTON));

      const input = screen.getByPlaceholderText('e.g., Where are my keys?');
      fireEvent.changeText(input, 'Where is my wallet?');
      fireEvent.press(screen.getByText('Ask AI'));

      await waitFor(() => {
        expect(screen.getByText('Your wallet is on the kitchen table')).toBeOnTheScreen();
      });
    });

    it('does not search when query is empty', async () => {
      const mockInvoke = supabase.functions.invoke as jest.Mock;

      render(<App />);
      fireEvent.press(screen.getByText(SEARCH_BUTTON));
      fireEvent.press(screen.getByText('Ask AI'));

      await waitFor(() => {
        expect(mockInvoke).not.toHaveBeenCalled();
      });
    });
  });
});
