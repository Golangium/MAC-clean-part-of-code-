// http://localhost:8080/web/index.html
package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/disintegration/imaging"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

var dbPool *pgxpool.Pool

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type WSClient struct {
	conn      *websocket.Conn
	sessionID string
	send      chan []byte
}

var (
	sessions = make(map[string][]*WSClient)
	mu       sync.Mutex
)

var (
	isSiteBlocked bool = false
)

// ==================== ФУНКЦИЯ БЛОКИРОВКИ СТРАНИЦЫ ====================

// Middleware для проверки блокировки на главной странице и столе
func checkBlockStatus(c *gin.Context) {
	if isSiteBlocked {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error":   "site_blocked",
			"message": "Доступ временно ограничен. Для разблокировки обратитесь к администратору.",
		})
		c.Abort()
		return
	}
	c.Next()
}

// Эндпоинты для админа
func toggleBlockSite(c *gin.Context) {
	isSiteBlocked = !isSiteBlocked
	status := "разблокирован"
	if isSiteBlocked {
		status = "заблокирован"
	}
	c.JSON(http.StatusOK, gin.H{
		"status":  "success",
		"message": fmt.Sprintf("Сайт успешно %s", status),
		"blocked": isSiteBlocked,
	})
}

func getBlockStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"blocked": isSiteBlocked,
	})
}

// ==================== ФУНКЦИИ ДЛЯ ФОНОВ ====================

func getBackgrounds(c *gin.Context) {
	rows, err := dbPool.Query(context.Background(), "SELECT id, name, image_url, created_at FROM backgrounds ORDER BY created_at DESC")
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()

	var backgrounds []gin.H
	for rows.Next() {
		var id, name, imageUrl string
		var createdAt time.Time
		rows.Scan(&id, &name, &imageUrl, &createdAt)
		backgrounds = append(backgrounds, gin.H{
			"id":         id,
			"name":       name,
			"image_url":  imageUrl,
			"created_at": createdAt,
		})
	}
	c.JSON(200, backgrounds)
}

func uploadBackground(c *gin.Context) {
	file, header, err := c.Request.FormFile("backgroundImage")
	if err != nil {
		c.JSON(400, gin.H{"error": "No file uploaded"})
		return
	}
	defer file.Close()

	backgroundName := c.PostForm("backgroundName")
	if backgroundName == "" {
		backgroundName = "Background " + time.Now().Format("2006-01-02")
	}

	bgDir := filepath.Join("uploads", "backgrounds")
	os.MkdirAll(bgDir, 0755)

	ext := filepath.Ext(header.Filename)
	filename := fmt.Sprintf("%d%s", time.Now().UnixNano(), ext)
	destPath := filepath.Join(bgDir, filename)

	dst, err := os.Create(destPath)
	if err != nil {
		c.JSON(500, gin.H{"error": "Save error"})
		return
	}
	defer dst.Close()

	io.Copy(dst, file)

	imageUrl := "/uploads/backgrounds/" + filename
	var bgId string
	err = dbPool.QueryRow(context.Background(),
		"INSERT INTO backgrounds (id, name, image_url, created_at) VALUES (gen_random_uuid(), $1, $2, NOW()) RETURNING id",
		backgroundName, imageUrl).Scan(&bgId)

	if err != nil {
		os.Remove(destPath)
		c.JSON(500, gin.H{"error": "DB error"})
		return
	}

	c.JSON(200, gin.H{"status": "success", "id": bgId, "url": imageUrl})
}

func deleteBackground(c *gin.Context) {
	bgId := c.Param("id")

	var imageUrl string
	err := dbPool.QueryRow(context.Background(), "SELECT image_url FROM backgrounds WHERE id = $1", bgId).Scan(&imageUrl)
	if err != nil {
		c.JSON(404, gin.H{"error": "Not found"})
		return
	}

	dbPool.Exec(context.Background(), "DELETE FROM backgrounds WHERE id = $1", bgId)

	if !strings.HasPrefix(imageUrl, "/uploads/backgrounds/default") {
		filePath := filepath.Join("uploads", imageUrl)
		os.Remove(filePath)
	}

	c.JSON(200, gin.H{"status": "deleted"})
}

const ADMIN_PASSWORD = ""

func adminAuth(c *gin.Context) {
	var req struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"success": false, "error": "Invalid request"})
		return
	}
	if req.Password == ADMIN_PASSWORD {
		c.SetCookie("admin_session", "authenticated", 3600*24*7, "/", "", false, true)
		c.JSON(200, gin.H{"success": true, "message": "Успешный вход"})
	} else {
		c.JSON(401, gin.H{"success": false, "error": "Неверный пароль"})
	}
}

func main() {
	// ===== ЗАГРУЗКА .ENV =====
	if err := godotenv.Load(); err != nil {
		log.Println("⚠️ .env not found")
	}

	// ===== ПОДКЛЮЧЕНИЕ К БД =====
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
		os.Getenv("DB_USER"), os.Getenv("DB_PASS"),
		os.Getenv("DB_HOST"), os.Getenv("DB_PORT"), os.Getenv("DB_NAME"))

	var err error
	dbPool, err = pgxpool.New(context.Background(), dsn)
	if err != nil {
		log.Fatalf("DB Connect Error: %v", err)
	}
	defer dbPool.Close()
	if err := dbPool.Ping(context.Background()); err != nil {
		log.Fatalf("DB Ping Error: %v", err)
	}
	log.Println("Connected to PostgreSQL")

	// ===== НАСТРОЙКА GIN =====
	r := gin.Default()

	// ===== СТАТИКА (всегда доступна, даже при блокировке) =====
	r.Static("/web", "./web")
	r.Static("/uploads", "./uploads")

	// ===== АДМИНКА (всегда доступна, чтобы можно было разблокировать) =====
	r.StaticFile("/admin", "./web/admin.html")
	r.StaticFile("/admin/dashboard", "./web/admin-dashboard.html")

	// ===== АДМИН API (всегда доступно) =====
	adminAPI := r.Group("/api/admin")
	{
		adminAPI.POST("/auth", adminAuth)
		adminAPI.POST("/upload-deck", uploadDeck)
		adminAPI.DELETE("/decks/:id", deleteDeck)
		adminAPI.GET("/decks", getAdminDecks)
		adminAPI.POST("/upload-background", uploadBackground)
		adminAPI.GET("/backgrounds", getBackgrounds)
		adminAPI.DELETE("/backgrounds/:id", deleteBackground)

		// Эндпоинты для блокировки
		adminAPI.POST("/toggle-block", toggleBlockSite)
		adminAPI.GET("/block-status", getBlockStatus)
	}

	// ===== ПУБЛИЧНЫЕ МАРШРУТЫ (с проверкой блокировки) =====
	public := r.Group("/")
	public.Use(checkBlockStatus) // <-- Здесь включается проверка!
	{
		// Главная страница
		public.GET("/", func(c *gin.Context) {
			c.File("./web/index.html")
		})

		// Страница стола
		public.GET("/table/:id", func(c *gin.Context) {
			c.File("./web/table.html")
		})

		// API сессий
		public.POST("/api/sessions", createSession)
		public.GET("/api/sessions/:id", getSessionState)
		public.POST("/api/sessions/:id/save", saveSessionState)

		// API колод
		public.GET("/api/decks", getDecks)
		public.GET("/api/decks/:id/cards", getDeckCards)

		// WebSocket (синхронизация стола)
		public.GET("/ws/:id", handleWebSocket)
	}

	// ===== ПРОЧИЕ ПУБЛИЧНЫЕ МАРШРУТЫ (без проверки) =====
	r.GET("/ping", func(c *gin.Context) { c.JSON(200, gin.H{"status": "ok"}) })

	// ИСПРАВЛЕНИЕ: Middleware для кэширования ДОЛЖЕН быть ДО r.Run()
	r.Use(func(c *gin.Context) {
		// Кэшируем картинки из папки web/images и файлы из uploads на 1 год
		if strings.HasPrefix(c.Request.URL.Path, "/web/images/") || strings.HasPrefix(c.Request.URL.Path, "/uploads/") {
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
		}
		c.Next()
	})

	// ===== ЗАПУСК СЕРВЕРА =====
	log.Println("🚀 Server starting on :8080")
	r.Run(":8080")
}

// ==================== СЕССИИ И WS ====================

func createSession(c *gin.Context) {
	var id string
	if err := dbPool.QueryRow(context.Background(), "INSERT INTO sessions (id, state) VALUES (gen_random_uuid(), '{}') RETURNING id").Scan(&id); err != nil {
		c.JSON(500, gin.H{"error": "DB error"})
		return
	}
	c.JSON(200, gin.H{"id": id})
}

func getSessionState(c *gin.Context) {
	var state string
	if err := dbPool.QueryRow(context.Background(), "SELECT state FROM sessions WHERE id = $1", c.Param("id")).Scan(&state); err != nil {
		c.JSON(404, gin.H{"error": "Not found"})
		return
	}
	c.JSON(200, gin.H{"id": c.Param("id"), "state": state})
}

func saveSessionState(c *gin.Context) {
	var body struct {
		State string `json:"state"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(400, gin.H{"error": "Invalid JSON"})
		return
	}
	if _, err := dbPool.Exec(context.Background(), "UPDATE sessions SET state = $1, updated_at = NOW() WHERE id = $2", body.State, c.Param("id")); err != nil {
		c.JSON(500, gin.H{"error": "DB save error"})
		return
	}
	c.JSON(200, gin.H{"status": "saved"})
}

func getDecks(c *gin.Context) {
	rows, err := dbPool.Query(context.Background(), "SELECT id, name, cover_image_url FROM decks ORDER BY created_at DESC")
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var decks []gin.H
	for rows.Next() {
		var id, name, cover string
		rows.Scan(&id, &name, &cover)
		decks = append(decks, gin.H{"id": id, "name": name, "cover_image_url": cover})
	}
	c.JSON(200, decks)
}

func getDeckCards(c *gin.Context) {
	rows, err := dbPool.Query(context.Background(), "SELECT id, image_url, back_image_url, number FROM cards WHERE deck_id = $1 ORDER BY number", c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var cards []gin.H
	for rows.Next() {
		var id, img, back string
		var num int
		rows.Scan(&id, &img, &back, &num)
		cards = append(cards, gin.H{"id": id, "image_url": img, "back_image_url": back, "number": num})
	}
	c.JSON(200, cards)
}

func handleWebSocket(c *gin.Context) {
	sessionID := c.Param("id")
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	client := &WSClient{conn: conn, sessionID: sessionID, send: make(chan []byte, 256)}
	mu.Lock()
	sessions[sessionID] = append(sessions[sessionID], client)
	mu.Unlock()

	var dbState string
	dbPool.QueryRow(context.Background(), "SELECT state FROM sessions WHERE id = $1", sessionID).Scan(&dbState)
	client.send <- []byte(fmt.Sprintf(`{"type":"init","state":%s}`, dbState))

	go client.writePump()
	go client.readPump(sessionID)
}

func (c *WSClient) readPump(sessionID string) {
	defer func() {
		c.conn.Close()
		mu.Lock()
		clients := sessions[sessionID]
		for i, cl := range clients {
			if cl == c {
				sessions[sessionID] = append(clients[:i], clients[i+1:]...)
				break
			}
		}
		mu.Unlock()
	}()

	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var data map[string]interface{}
		if json.Unmarshal(msg, &data) != nil {
			continue
		}

		if data["type"] == "state_save" {
			if stateVal, ok := data["state"].(string); ok {
				dbPool.Exec(context.Background(), "UPDATE sessions SET state = $1, updated_at = NOW() WHERE id = $2", stateVal, sessionID)
				c.send <- []byte(`{"type":"state_save_ack"}`)
			}
		}

		mu.Lock()
		for _, cl := range sessions[sessionID] {
			if cl != c {
				select {
				case cl.send <- msg:
				default:
					close(cl.send)
				}
			}
		}
		mu.Unlock()
	}
}

func (c *WSClient) writePump() {
	defer c.conn.Close()
	for {
		msg, ok := <-c.send
		if !ok {
			c.conn.WriteMessage(websocket.CloseMessage, []byte{})
			return
		}
		c.conn.WriteMessage(websocket.TextMessage, msg)
	}
}

// ==================== АДМИН-ФУНКЦИИ ====================

func getAdminDecks(c *gin.Context) {
	rows, err := dbPool.Query(context.Background(), "SELECT id, name, cover_image_url, created_at FROM decks ORDER BY created_at DESC")
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	defer rows.Close()
	var decks []gin.H
	for rows.Next() {
		var id, name, cover string
		var createdAt string
		rows.Scan(&id, &name, &cover, &createdAt)
		decks = append(decks, gin.H{"id": id, "name": name, "cover_image_url": cover, "created_at": createdAt})
	}
	c.JSON(200, decks)
}

func deleteDeck(c *gin.Context) {
	deckID := c.Param("id")
	dbPool.Exec(context.Background(), "DELETE FROM cards WHERE deck_id = $1", deckID)
	dbPool.Exec(context.Background(), "DELETE FROM decks WHERE id = $1", deckID)
	c.JSON(200, gin.H{"status": "deleted"})
}

func uploadDeck(c *gin.Context) {
	file, header, err := c.Request.FormFile("deckArchive")
	if err != nil {
		c.JSON(400, gin.H{"error": "No file uploaded"})
		return
	}
	defer file.Close()

	deckName := c.PostForm("deckName")
	if deckName == "" {
		deckName = "New Deck"
	}

	tempDir := filepath.Join("uploads", "temp", fmt.Sprintf("%d_%s", time.Now().Unix(), header.Filename))
	os.RemoveAll(tempDir)
	os.MkdirAll(tempDir, 0755)
	defer os.RemoveAll(tempDir)

	zipPath := filepath.Join(tempDir, "archive.zip")
	dst, err := os.Create(zipPath)
	if err != nil {
		c.JSON(500, gin.H{"error": "Save temp error"})
		return
	}
	io.Copy(dst, file)
	dst.Close()

	r, err := zip.OpenReader(zipPath)
	if err != nil {
		c.JSON(500, gin.H{"error": "Invalid zip file: " + err.Error()})
		return
	}
	defer r.Close()

	for _, f := range r.File {
		if f.FileInfo().IsDir() {
			continue
		}
		dstPath := filepath.Join(tempDir, f.Name)
		os.MkdirAll(filepath.Dir(dstPath), 0755)
		src, err := f.Open()
		if err != nil {
			continue
		}
		dst, err := os.Create(dstPath)
		if err != nil {
			src.Close()
			continue
		}
		io.Copy(dst, src)
		src.Close()
		dst.Close()
	}

	coverPath := findFile(tempDir, "cover")
	backPath := findFile(tempDir, "back")
	facesDir := filepath.Join(tempDir, "faces")

	if _, err := os.Stat(facesDir); os.IsNotExist(err) {
		var foundFaces string
		filepath.Walk(tempDir, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if info.IsDir() && strings.ToLower(info.Name()) == "faces" {
				foundFaces = path
				return filepath.SkipDir
			}
			return nil
		})
		if foundFaces != "" {
			facesDir = foundFaces
			parentDir := filepath.Dir(facesDir)
			if coverPath == "" {
				coverPath = findFile(parentDir, "cover")
			}
			if backPath == "" {
				backPath = findFile(parentDir, "back")
			}
		}
	}

	if coverPath == "" || backPath == "" {
		if coverPath == "" {
			coverPath = findFile(tempDir, "cover")
		}
		if backPath == "" {
			backPath = findFile(tempDir, "back")
		}
		if coverPath == "" || backPath == "" {
			c.JSON(400, gin.H{"error": "Missing cover or back image. Please ensure 'cover.jpg/png' and 'back.jpg/png' are in the archive."})
			return
		}
	}

	deckFolder := filepath.Join("uploads", "decks", strings.ReplaceAll(deckName, " ", "_")+"_"+fmt.Sprint(time.Now().Unix()))
	os.MkdirAll(filepath.Join(deckFolder, "faces"), 0755)

	finalCover := processImage(coverPath, filepath.Join(deckFolder, "cover.jpg"), 200, 300)
	finalBack := processImage(backPath, filepath.Join(deckFolder, "back.jpg"), 600, 900)

	if finalCover == "" || finalBack == "" {
		c.JSON(500, gin.H{"error": "Error processing cover or back image"})
		return
	}

	var deckID string
	err = dbPool.QueryRow(context.Background(),
		"INSERT INTO decks (id, name, cover_image_url, created_at) VALUES (gen_random_uuid(), $1, $2, NOW()) RETURNING id",
		deckName, "/"+finalCover).Scan(&deckID)

	if err != nil {
		c.JSON(500, gin.H{"error": "DB insert deck error"})
		return
	}

	files, _ := os.ReadDir(facesDir)
	cardCount := 0

	for _, f := range files {
		if f.IsDir() {
			continue
		}
		srcPath := filepath.Join(facesDir, f.Name())
		ext := strings.ToLower(filepath.Ext(srcPath))
		if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp" {
			continue
		}
		destName := fmt.Sprintf("%d.jpg", cardCount+1)
		destPath := filepath.Join(deckFolder, "faces", destName)
		finalImg := processImage(srcPath, destPath, 600, 900)
		if finalImg == "" {
			log.Printf("Skipping invalid image: %s", srcPath)
			continue
		}
		_, err := dbPool.Exec(context.Background(),
			"INSERT INTO cards (id, deck_id, image_url, back_image_url, number) VALUES (gen_random_uuid(), $1, $2, $3, $4)",
			deckID, "/"+finalImg, "/"+finalBack, cardCount+1)
		if err != nil {
			log.Printf("Error inserting card %s: %v", f.Name(), err)
		}
		cardCount++
	}

	if cardCount == 0 {
		dbPool.Exec(context.Background(), "DELETE FROM decks WHERE id = $1", deckID)
		c.JSON(400, gin.H{"error": "No valid face images found in 'faces/' folder"})
		return
	}

	c.JSON(200, gin.H{"status": "success", "count": cardCount, "deckId": deckID})
}

func findFile(root, namePrefix string) string {
	var found string
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if path != root && filepath.Dir(path) != root {
				return filepath.SkipDir
			}
			return nil
		}
		base := strings.ToLower(info.Name())
		if strings.HasPrefix(base, namePrefix) && (strings.HasSuffix(base, ".jpg") || strings.HasSuffix(base, ".png") || strings.HasSuffix(base, ".jpeg")) {
			found = path
			return filepath.SkipDir
		}
		return nil
	})
	return found
}

func processImage(src, dst string, width, height int) string {
	img, err := imaging.Open(src)
	if err != nil {
		log.Printf("Error opening image %s: %v", src, err)
		return ""
	}
	img = imaging.Resize(img, width, 0, imaging.Lanczos)
	if img.Bounds().Dy() < height {
		img = imaging.Resize(img, 0, height, imaging.Lanczos)
	}
	img = imaging.CropCenter(img, width, height)
	err = imaging.Save(img, dst, imaging.JPEGQuality(55))
	if err != nil {
		log.Printf("Error saving image %s: %v", dst, err)
		return ""
	}
	return dst
}
