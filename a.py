# Read the file
with open('words.txt', 'r') as file:
    words = file.readlines()

# Remove any whitespace and sort
words = [word.strip() for word in words]
words.sort()

# Write back to file (or create new file)
with open('words-sorted.txt', 'w') as file:
    for word in words:
        file.write(word + '\n')

print("Done! Sorted words saved to words-sorted.txt")