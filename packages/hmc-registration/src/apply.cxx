// --apply: resample a 3D image through ANTs transforms, as antsApplyTransforms does.
//
//   --apply fixed moving output interpolation fill transform [transform...]
//
// interpolation: Linear, NearestNeighbor, BSpline (order 3), BSpline[order] (0 to 5),
// HammingWindowedSinc or LanczosWindowedSinc, as antsApplyTransforms names them, case-insensitive.
// fill is the value of output voxels that map outside the moving image.
// A transform written as inverse:name is inverted. The last positional transform acts first on
// an output-to-input sampling point. Reverse native antsApplyTransforms' -t list when calling
// this interface: --apply ... A B corresponds to native ... -t B -t A. ITK applies this queue
// in reverse, so add these positional arguments in order. See validation/transform-order.md.
//
// Pixels are float. Interpolation, resampling and transforms are double, as in
// antsApplyTransforms without --float. The interpolators are the ones antsApplyTransforms builds
// (Examples/make_interpolator_snip.tmpl): windowed sinc with radius 3 and a constant (zero)
// boundary, B-spline with double coefficients.
#include "itkBSplineInterpolateImageFunction.h"
#include "itkCompositeTransform.h"
#include "itkConstantBoundaryCondition.h"
#include "itkImageFileReader.h"
#include "itkImageFileWriter.h"
#include "itkLinearInterpolateImageFunction.h"
#include "itkNearestNeighborInterpolateImageFunction.h"
#include "itkResampleImageFilter.h"
#include "itkWindowedSincInterpolateImageFunction.h"
#include "itkantsReadWriteTransform.h"
#include <algorithm>
#include <cctype>
#include <regex>
#include <cstdlib>
#include <iostream>
#include <string>

namespace {
using Image = itk::Image<float, 3>;
using Interpolator = itk::InterpolateImageFunction<Image, double>;
template <typename Window>
using Sinc = itk::WindowedSincInterpolateImageFunction<Image, 3, Window, itk::ConstantBoundaryCondition<Image>, double>;

Interpolator::Pointer makeInterpolator(std::string name) {
  std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (name == "linear") return itk::LinearInterpolateImageFunction<Image, double>::New().GetPointer();
  if (name == "nearestneighbor") return itk::NearestNeighborInterpolateImageFunction<Image, double>::New().GetPointer();
  if (name == "hammingwindowedsinc") return Sinc<itk::Function::HammingWindowFunction<3, double, double>>::New().GetPointer();
  if (name == "lanczoswindowedsinc") return Sinc<itk::Function::LanczosWindowFunction<3, double, double>>::New().GetPointer();
  std::smatch match;
  if (std::regex_match(name, match, std::regex("bspline(?:\\[([0-5])\\])?"))) {
    auto bspline = itk::BSplineInterpolateImageFunction<Image, double>::New();
    if (match[1].matched) bspline->SetSplineOrder(static_cast<unsigned int>(std::stoi(match[1].str())));
    return bspline.GetPointer();
  }
  return nullptr;
}

// Exceptions are not caught in this WebAssembly build (a throw aborts the kernel), so argument
// errors are reported and the run exits 1.
int refuse(const std::string& message) {
  std::cerr << message << std::endl;
  return 1;
}
}  // namespace

int applyTransforms(int argc, char* argv[]) {
  if (argc < 8) return refuse("--apply needs fixed, moving, output, interpolation, fill and at least one transform");
  auto interpolator = makeInterpolator(argv[5]);
  if (!interpolator) {
    return refuse(std::string("Unknown interpolation ") + argv[5] +
                  ": use Linear, NearestNeighbor, BSpline, BSpline[0-5], HammingWindowedSinc or LanczosWindowedSinc");
  }
  char* end = nullptr;
  const float fill = std::strtof(argv[6], &end);
  if (end == argv[6] || *end != '\0') return refuse(std::string("The fill value is not a number: ") + argv[6]);
  auto fixedReader = itk::ImageFileReader<Image>::New();
  fixedReader->SetFileName(argv[2]);
  fixedReader->UpdateOutputInformation();
  auto movingReader = itk::ImageFileReader<Image>::New();
  movingReader->SetFileName(argv[3]);
  movingReader->Update();
  auto composite = itk::CompositeTransform<double, 3>::New();
  for (int i = 7; i < argc; ++i) {
    std::string path(argv[i]);
    const bool inverse = path.rfind("inverse:", 0) == 0;
    if (inverse) path = path.substr(8);
    auto transform = itk::ants::ReadTransform<double, 3>(path);
    if (!transform) return refuse("Cannot read transform: " + path);
    if (inverse) transform = transform->GetInverseTransform();
    if (!transform) return refuse("Transform has no inverse: " + path);
    composite->AddTransform(transform);
  }
  auto resample = itk::ResampleImageFilter<Image, Image, double>::New();
  resample->SetInput(movingReader->GetOutput());
  resample->SetOutputParametersFromImage(fixedReader->GetOutput());
  resample->SetTransform(composite);
  resample->SetInterpolator(interpolator);
  resample->SetDefaultPixelValue(fill);
  auto writer = itk::ImageFileWriter<Image>::New();
  writer->SetFileName(argv[4]);
  writer->SetInput(resample->GetOutput());
  writer->Update();
  return 0;
}
