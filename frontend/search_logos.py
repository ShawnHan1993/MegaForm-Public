import urllib.request
import re
import json

def search(query):
    url = f"https://duckduckgo.com/html/?q={urllib.parse.quote(query)}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
            links = re.findall(r'class="result__url" href="([^"]+)"', html)
            print(f"Results for {query}:")
            for link in links[:5]:
                print(urllib.parse.unquote(link))
    except Exception as e:
        print(f"Error: {e}")

search("zhipu ai logo svg")
search("minimax ai logo svg")
