using System;

public class Vehiculo
{
    public string Marca { get; set; }
    public string Modelo { get; set; }

    public Vehiculo(string marca, string modelo)
    {
        Marca = marca;
        Modelo = modelo;
    }

    public virtual void MostrarInfo()
    {
        Console.WriteLine($"Marca: {Marca}, Modelo: {Modelo}");
    }
}

public class Coche : Vehiculo
{
    public int NumeroPuertas { get; set; }

    public Coche(string marca, string modelo, int numeroPuertas) : base(marca, modelo)
    {
        NumeroPuertas = numeroPuertas;
    }

    public override void MostrarInfo()
    {
        base.MostrarInfo();
        Console.WriteLine($"Número de puertas: {NumeroPuertas}");
    }
}

class Program
{
    static void Main()
    {
        Coche coche = new Coche("Toyota", "Corolla", 4);
        coche.MostrarInfo();
    }
}