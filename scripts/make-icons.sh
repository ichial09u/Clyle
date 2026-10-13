#!/bin/bash
# make-icons.sh — generate Android launcher icons from the app's icon-512.png
set -e
SRC=/home/z/my-project/src/public/icon-512.png
RES=/home/z/my-project/mobile/android/app/src/main/res

# density -> legacy size / adaptive-foreground size
declare -A LEG=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
declare -A FG=( [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432 )

for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  dir="$RES/mipmap-$d"
  # drop the stock webp files so our pngs take over the resource names
  rm -f "$dir"/ic_launcher.webp "$dir"/ic_launcher_foreground.webp "$dir"/ic_launcher_round.webp
  # legacy square launcher
  ffmpeg -y -loglevel error -i "$SRC" -vf "scale=${LEG[$d]}:${LEG[$d]}" "$dir/ic_launcher.png"
  # adaptive foreground: icon inside the 66% safe zone on transparent canvas
  s=${FG[$d]}
  inner=$(( s * 66 / 100 ))
  ffmpeg -y -loglevel error -i "$SRC" -vf "scale=${inner}:${inner},pad=${s}:${s}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba" "$dir/ic_launcher_foreground.png"
done

# dark launcher background (matches the app shell)
cat > "$RES/values/ic_launcher_background.xml" << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0a0a0a</color>
</resources>
EOF
echo "ICONS_OK"
