
package consumidor_test

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"talentflow/perfiles-service/internal/consumidor"
	"talentflow/perfiles-service/internal/eventos"
	"talentflow/perfiles-service/internal/store"
	"talentflow/perfiles-service/internal/testutil"
)

func nuevo(t *testing.T) (*consumidor.Consumidor, *store.Store, *sql.DB) {
	t.Helper()
	db := testutil.Conectar(t)
	s := store.New(db)
	return &consumidor.Consumidor{
		Store: s,
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, s, db
}

func evento(id, tipo, data string) []byte {
	return []byte(fmt.Sprintf(
		`{"id":%q,"type":%q,"version":1,"occurredAt":"2026-10-10T12:00:00Z","producer":"empleados-service","data":%s}`,
		id, tipo, data,
	))
}

const dataCreado = `{"empleadoId":"E001","nombre":"Juan","apellido":"Pérez","email":"juan.perez@empresa.com",
	"numeroEmpleado":"EMP-2026-001","cargo":"Desarrollador Senior","area":"Tecnología","departamentoId":"IT",
	"fechaIngreso":"2026-02-10","estado":"ACTIVO"}`

func TestCreadoGeneraPerfilPorDefecto(t *testing.T) {
	c, s, _ := nuevo(t)
	ctx := context.Background()

	res, err := c.Manejar(ctx, evento("creado-1", eventos.EmpleadoCreado, dataCreado))
	if err != nil {
		t.Fatalf("Manejar() error: %v", err)
	}
	if res != "procesado" {
		t.Fatalf("resultado = %q, se esperaba procesado", res)
	}

	p, err := s.Obtener(ctx, "E001")
	if err != nil {
		t.Fatalf("Obtener() error: %v", err)
	}

	if p.ID == "" {
		t.Error("el perfil debe tener un ID")
	}
	if p.EmpleadoID != "E001" {
		t.Errorf("EmpleadoID = %q, se esperaba E001", p.EmpleadoID)
	}

	if p.Nombre != "" || p.Apellido != "" || p.Email != "" ||
		p.Cargo != "" || p.Area != "" || p.DepartamentoID != "" {
		t.Errorf("los datos del empleado deben iniciar vacíos: %+v", p)
	}

	if p.Telefono != "" || p.Direccion != "" ||
		p.Ciudad != "" || p.Biografia != "" {
		t.Errorf("los campos propios del perfil deben iniciar vacíos: %+v", p)
	}

	if time.Time(p.FechaCreacion).IsZero() {
		t.Error("FechaCreacion debe tener un valor")
	}
	if p.Archivado {
		t.Error("el perfil nuevo no debe estar archivado")
	}
	if p.FechaArchivado != nil {
		t.Error("FechaArchivado debe ser nil")
	}
}

func TestDeduplicacionMismoIdUnSoloEfecto(t *testing.T) {
	c, s, db := nuevo(t)
	ctx := context.Background()

	res, err := c.Manejar(ctx, evento("mismo-id", eventos.EmpleadoCreado, dataCreado))
	if err != nil || res != "procesado" {
		t.Fatalf("primera entrega: res=%q err=%v", res, err)
	}

	otro := `{"empleadoId":"E001","nombre":"OTRO","email":"otro@empresa.com"}`
	res, err = c.Manejar(ctx, evento("mismo-id", eventos.EmpleadoCreado, otro))
	if err != nil || res != "duplicado" {
		t.Fatalf("segunda entrega: res=%q err=%v", res, err)
	}

	var perfiles, registrados int
	if err := db.QueryRow(`SELECT count(*) FROM perfiles`).Scan(&perfiles); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM eventos_procesados WHERE id='mismo-id'`).Scan(&registrados); err != nil {
		t.Fatal(err)
	}
	if perfiles != 1 || registrados != 1 {
		t.Errorf("perfiles=%d registrados=%d, se esperaba 1 y 1", perfiles, registrados)
	}

	p, err := s.Obtener(ctx, "E001")
	if err != nil {
		t.Fatal(err)
	}
	if p.Nombre != "" || p.Email != "" {
		t.Errorf("el evento duplicado modificó el perfil: nombre=%q email=%q", p.Nombre, p.Email)
	}
}

func TestCreadoConIdsDistintosParaElMismoEmpleadoNoDuplicaPerfil(t *testing.T) {
	c, _, db := nuevo(t)
	ctx := context.Background()

	for _, id := range []string{"a", "b"} {
		if _, err := c.Manejar(ctx, evento(id, eventos.EmpleadoCreado, dataCreado)); err != nil {
			t.Fatalf("evento %s: %v", id, err)
		}
	}

	var n int
	if err := db.QueryRow(`SELECT count(*) FROM perfiles`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("perfiles=%d, se esperaba 1", n)
	}
}

func TestActualizadoSincronizaSinPisarCamposDelPerfil(t *testing.T) {
	c, s, db := nuevo(t)
	ctx := context.Background()

	if _, err := c.Manejar(ctx, evento("crear", eventos.EmpleadoCreado, dataCreado)); err != nil {
		t.Fatal(err)
	}

	_, err := db.ExecContext(ctx,
		`UPDATE perfiles SET telefono=$1, ciudad=$2 WHERE empleado_id=$3`,
		"3001234567", "Armenia", "E001",
	)
	if err != nil {
		t.Fatal(err)
	}

	actualizado := `{"empleadoId":"E001","nombre":"Juan","apellido":"Gómez","email":"juan@empresa.com",
		"cargo":"Líder","area":"Tecnología","departamentoId":"IT"}`

	res, err := c.Manejar(ctx, evento("actualizar-1", eventos.EmpleadoActualizado, actualizado))
	if err != nil || res != "procesado" {
		t.Fatalf("actualización: res=%q err=%v", res, err)
	}

	p, err := s.Obtener(ctx, "E001")
	if err != nil {
		t.Fatal(err)
	}
	if p.Nombre != "Juan" || p.Apellido != "Gómez" || p.Email != "juan@empresa.com" {
		t.Errorf("datos del empleado no sincronizados: %+v", p)
	}
	if p.Cargo != "Líder" || p.Area != "Tecnología" || p.DepartamentoID != "IT" {
		t.Errorf("cargo/área/departamento no sincronizados: %+v", p)
	}
	if p.Telefono != "3001234567" || p.Ciudad != "Armenia" {
		t.Errorf("la actualización pisó campos propios del perfil: %+v", p)
	}
}

func TestActualizadoSinPerfilLoCrea(t *testing.T) {
	c, s, _ := nuevo(t)
	ctx := context.Background()

	actualizado := `{"empleadoId":"E002","nombre":"Ana","apellido":"López","email":"ana@empresa.com",
		"cargo":"Analista","area":"Finanzas","departamentoId":"FIN"}`

	res, err := c.Manejar(ctx, evento("actualizar-sin-crear", eventos.EmpleadoActualizado, actualizado))
	if err != nil || res != "procesado" {
		t.Fatalf("actualización: res=%q err=%v", res, err)
	}

	p, err := s.Obtener(ctx, "E002")
	if err != nil {
		t.Fatal(err)
	}
	if p.Nombre != "Ana" || p.Email != "ana@empresa.com" {
		t.Errorf("perfil no creado/sincronizado: %+v", p)
	}
}

func TestRetiradoArchivaPerfil(t *testing.T) {
	c, s, _ := nuevo(t)
	ctx := context.Background()

	if _, err := c.Manejar(ctx, evento("crear-retiro", eventos.EmpleadoCreado, dataCreado)); err != nil {
		t.Fatal(err)
	}

	dataRetiro := `{"empleadoId":"E001","email":"juan.perez@empresa.com","fechaRetiro":"2026-10-10","motivo":"Fin de contrato"}`
	res, err := c.Manejar(ctx, evento("retirar-1", eventos.EmpleadoRetirado, dataRetiro))
	if err != nil || res != "procesado" {
		t.Fatalf("retiro: res=%q err=%v", res, err)
	}

	p, err := s.Obtener(ctx, "E001")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Archivado {
		t.Error("el perfil debe quedar archivado")
	}
	if p.FechaArchivado == nil {
		t.Error("FechaArchivado debe tener valor")
	}
}

func TestRetiradoSinPerfilNoFalla(t *testing.T) {
	c, _, _ := nuevo(t)
	ctx := context.Background()

	dataRetiro := `{"empleadoId":"E999","email":"desconocido@empresa.com","fechaRetiro":"2026-10-10"}`
	res, err := c.Manejar(ctx, evento("retirar-inexistente", eventos.EmpleadoRetirado, dataRetiro))
	if err != nil {
		t.Fatalf("el retiro sin perfil no debe fallar: %v", err)
	}
	if res != "procesado" {
		t.Errorf("resultado = %q, se esperaba procesado", res)
	}
}

func TestEventoMalformadoDevuelveError(t *testing.T) {
	c, _, _ := nuevo(t)

	_, err := c.Manejar(context.Background(), []byte(`{"id":`))
	if err == nil {
		t.Error("se esperaba error para evento malformado")
	}
}

func TestEventoDesconocidoSeIgnora(t *testing.T) {
	c, _, _ := nuevo(t)

	res, err := c.Manejar(context.Background(), evento("desconocido-1", "evento.desconocido", `{}`))
	if err != nil {
		t.Fatal(err)
	}
	if res != "ignorado" {
		t.Errorf("resultado = %q, se esperaba ignorado", res)
	}
}

func TestErrorDatosEmpleadoDevuelveError(t *testing.T) {
	c, _, _ := nuevo(t)

	dataIncompleta := `{"nombre":"Sin empleadoId"}`
	_, err := c.Manejar(context.Background(), evento("incompleto-1", eventos.EmpleadoCreado, dataIncompleta))
	if err == nil {
		t.Error("se esperaba error por datos incompletos")
	}
}

func TestErrorStoreSePropaga(t *testing.T) {
	c, _, db := nuevo(t)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	_, err := c.Manejar(context.Background(), evento("db-cerrada-1", eventos.EmpleadoCreado, dataCreado))
	if err == nil {
		t.Error("se esperaba error al usar la base de datos cerrada")
	}
}

