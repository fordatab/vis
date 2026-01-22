import { useState } from 'react';
import { StyleSheet, Text, View, Button, Image, ActivityIndicator, Alert, TextInput, ScrollView, Keyboard } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from './lib/supabase';

export default function App() {
  // Modes: 'capture' or 'search'
  const [mode, setMode] = useState<'capture' | 'search'>('capture');
  
  // Capture State
  const [image, setImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Search State
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<any>(null);
  const [searching, setSearching] = useState(false);

  // --- CAPTURE LOGIC (From Day 1) ---
  const pickImage = async () => {
    let result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.5,
      base64: true,
    });

    if (!result.canceled) {
      setImage(result.assets[0].uri);
      uploadToSupabase(result.assets[0]);
    }
  };

  const uploadToSupabase = async (photo: any) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', { uri: photo.uri, name: 'photo.jpg', type: 'image/jpeg' } as any);
      const fileName = `${Date.now()}.jpg`;

      await supabase.storage.from('images').upload(fileName, formData, { contentType: 'multipart/form-data' });
      const { data: urlData } = supabase.storage.from('images').getPublicUrl(fileName);
      
      await supabase.from('scans').insert([{ image_url: urlData.publicUrl }]);
      Alert.alert("Saved!", "I'm analyzing this photo now. Check back in 10 seconds.");
      setImage(null);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setUploading(false);
    }
  };

  // --- SEARCH LOGIC (New for Day 3) ---
  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchResult(null);
    Keyboard.dismiss();

    try {
      const { data, error } = await supabase.functions.invoke('search-items', {
        body: { query: query }
      });

      if (error) throw error;
      setSearchResult(data);
    } catch (e: any) {
      Alert.alert("Search Error", e.message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.nav}>
        <Button title="📸 Capture" onPress={() => setMode('capture')} />
        <Button title="🔍 Search" onPress={() => setMode('search')} />
      </View>

      {mode === 'capture' ? (
        <View style={styles.centerView}>
          <Text style={styles.title}>Visual Memory</Text>
          <Text style={styles.subtitle}>Snap photos of your stuff.</Text>
          {uploading ? <ActivityIndicator size="large" /> : <Button title="Take Photo" onPress={pickImage} />}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.centerView}>
          <Text style={styles.title}>Ask Recall</Text>
          <TextInput 
            style={styles.input} 
            placeholder="e.g., Where are my keys?" 
            value={query}
            onChangeText={setQuery} 
          />
          <Button title={searching ? "Searching..." : "Ask AI"} onPress={handleSearch} disabled={searching} />
          
          {searchResult && (
            <View style={styles.resultContainer}>
              <Text style={styles.answerText}>{searchResult.answer}</Text>
              {searchResult.image && (
                <Image source={{ uri: searchResult.image }} style={styles.resultImage} resizeMode="contain" />
              )}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 50 },
  nav: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 20 },
  centerView: { alignItems: 'center', padding: 20 },
  title: { fontSize: 28, fontWeight: 'bold', marginBottom: 10 },
  subtitle: { fontSize: 16, color: '#666', marginBottom: 30 },
  input: { width: '100%', height: 50, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, marginBottom: 15 },
  resultContainer: { marginTop: 30, alignItems: 'center', width: '100%' },
  answerText: { fontSize: 18, marginBottom: 15, textAlign: 'center' },
  resultImage: { width: 300, height: 400, borderRadius: 10, borderWidth: 2, borderColor: '#000' }
});