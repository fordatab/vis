import { useState } from 'react';
import { StyleSheet, Text, View, Button, Image, ActivityIndicator, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from './lib/supabase'; // Import the file you just made

export default function App() {
  const [image, setImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // 1. Pick Image
  const pickImage = async () => {
    let result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.5, // Keep quality low for MVP speed
      base64: true, // Needed for upload
    });

    if (!result.canceled) {
      setImage(result.assets[0].uri);
      uploadToSupabase(result.assets[0]);
    }
  };

  // 2. Upload to Supabase
  const uploadToSupabase = async (photo: any) => {
    setUploading(true);
    try {
      // FIX: Create a FormData object. This is the standard way to send files on Mobile.
      const formData = new FormData();
      formData.append('file', {
        uri: photo.uri,
        name: 'photo.jpg',
        type: 'image/jpeg',
      } as any);

      const fileName = `${Date.now()}.jpg`;

      // A. Upload using the standard fetch API, bypassing Supabase JS client for the upload part
      // (This is often more stable for file uploads on Expo)
      const { data, error } = await supabase.storage
        .from('images')
        .upload(fileName, formData, {
          contentType: 'multipart/form-data',
        });

      if (error) {
        console.error("Supabase Storage Error:", error);
        throw error;
      }

      // B. Get the Public URL
      const { data: urlData } = supabase.storage
        .from('images')
        .getPublicUrl(fileName);

      console.log("Image URL:", urlData.publicUrl);

      // C. Save Reference to Database
      const { error: dbError } = await supabase
        .from('scans')
        .insert([{ image_url: urlData.publicUrl }]);

      if (dbError) {
        console.error("Database Error:", dbError);
        throw dbError;
      }

      Alert.alert("Success!", "Image uploaded and database updated.");

    } catch (e: any) {
      console.error("Full Error Details:", e);
      Alert.alert("Upload Failed", e.message || "Unknown error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Visual Memory MVP</Text>
      
      {image && <Image source={{ uri: image }} style={styles.preview} />}
      
      <View style={styles.buttonContainer}>
        {uploading ? (
          <ActivityIndicator size="large" color="#0000ff" />
        ) : (
          <Button title="Take Photo" onPress={pickImage} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
  preview: { width: 300, height: 300, marginBottom: 20, borderRadius: 10 },
  buttonContainer: { marginTop: 10 },
});