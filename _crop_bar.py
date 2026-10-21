from PIL import Image, ImageDraw
im = Image.open("_v5_mid_after.png").convert("RGB")
W, H = im.size
print("size", W, H)
strip = im.crop((int(W*0.52), 0, int(W*0.83), 46))
k = 3
strip = strip.resize((strip.width*k, strip.height*k), Image.LANCZOS)
out = Image.new("RGB", (strip.width, strip.height+26), (255,255,255))
out.paste(strip, (0, 26))
d = ImageDraw.Draw(out)
d.text((6, 6), "收藏条: 趋势线 / 水平线 / 矩形 / 斐波那契(第4个) / 文字 / 尺子 | 磁吸 隐藏 清空", fill=(20,24,35))
out.save("_v5_drawbar_fib.png")
print("ok", out.size)
